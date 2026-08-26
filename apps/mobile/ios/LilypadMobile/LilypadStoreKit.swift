import Foundation
import StoreKit

/**
 * Thin StoreKit 2 bridge for Lilypad Pro.

 * Classic `RCTBridgeModule` interop (via `LilypadStoreKit.m`) is deliberate:
 * New Architecture is on, but TurboModule codegen for a one-off StoreKit
 * surface would cost more than it buys, and the promise-based bridge is what
 * the TypeScript wrappers already speak.

 * Entitlement truth lives on the control plane after we POST the JWS — this
 * module only reads Apple's signed transaction and finishes it so StoreKit
 * stops redelivering. Never "finish" before copying `jwsRepresentation`: a
 * finished transaction can still be read later via `latest` / entitlements,
 * but losing the JWS on the hot purchase path forces a restore round-trip.
 */
@objc(LilypadStoreKit)
class LilypadStoreKit: NSObject {

  // MARK: - RN bridge

  @objc static func requiresMainQueueSetup() -> Bool { false }

  /// Block signatures match `RCTPromiseResolveBlock` / `RCTPromiseRejectBlock`
  /// without a bridging header (this target has none — see Noop.swift).
  @objc func getProduct(
    _ productId: String,
    resolver resolve: @escaping (Any?) -> Void,
    rejecter reject: @escaping (String?, String?, Error?) -> Void
  ) {
    Task {
      do {
        let product = try await Self.fetchProduct(productId)
        resolve(Self.productDict(product))
      } catch {
        Self.reject(reject, code: "storekit_error", error: error)
      }
    }
  }

  @objc func purchase(
    _ productId: String,
    resolver resolve: @escaping (Any?) -> Void,
    rejecter reject: @escaping (String?, String?, Error?) -> Void
  ) {
    Task {
      do {
        let product = try await Self.fetchProduct(productId)
        let result = try await product.purchase()
        switch result {
        case .success(let verification):
          // JWS first, finish second — see file comment.
          let jws = verification.jwsRepresentation
          let transaction = try Self.unwrap(verification)
          let payload = Self.purchaseDict(transaction, jws: jws)
          await transaction.finish()
          resolve(payload)
        case .userCancelled:
          reject("user_cancelled", "Purchase cancelled.", nil)
        case .pending:
          reject(
            "pending",
            "Purchase is pending approval. Try again once it is approved.",
            nil
          )
        @unknown default:
          reject("storekit_error", "Unexpected purchase result.", nil)
        }
      } catch {
        Self.reject(reject, code: "storekit_error", error: error)
      }
    }
  }

  @objc func restore(
    _ resolve: @escaping (Any?) -> Void,
    rejecter reject: @escaping (String?, String?, Error?) -> Void
  ) {
    Task {
      do {
        // Surfaces Apple's account sheet when needed, then currentEntitlements
        // reflects what this Apple ID actually holds on this device.
        try await AppStore.sync()
        var purchases: [[String: Any]] = []
        for await verification in Transaction.currentEntitlements {
          do {
            let jws = verification.jwsRepresentation
            let transaction = try Self.unwrap(verification)
            purchases.append(Self.purchaseDict(transaction, jws: jws))
          } catch {
            // Skip unverified rows rather than failing the whole restore —
            // one bad local receipt should not block every other entitlement.
            continue
          }
        }
        resolve(purchases)
      } catch {
        Self.reject(reject, code: "storekit_error", error: error)
      }
    }
  }

  @objc func latestTransaction(
    _ productId: String,
    resolver resolve: @escaping (Any?) -> Void,
    rejecter reject: @escaping (String?, String?, Error?) -> Void
  ) {
    Task {
      do {
        guard let verification = await Transaction.latest(for: productId) else {
          resolve(NSNull())
          return
        }
        let jws = verification.jwsRepresentation
        let transaction = try Self.unwrap(verification)
        resolve(Self.purchaseDict(transaction, jws: jws))
      } catch {
        Self.reject(reject, code: "storekit_error", error: error)
      }
    }
  }

  // MARK: - Helpers

  private static func fetchProduct(_ productId: String) async throws -> Product {
    let products = try await Product.products(for: [productId])
    guard let product = products.first else {
      throw StoreKitBridgeError.productNotFound(productId)
    }
    return product
  }

  private static func unwrap<T>(_ result: VerificationResult<T>) throws -> T {
    switch result {
    case .verified(let value):
      return value
    case .unverified(_, let error):
      throw error
    }
  }

  private static func productDict(_ product: Product) -> [String: Any] {
    let intro = product.subscription?.introductoryOffer
    let label = intro.map(Self.introOfferLabel(for:))
    return [
      "productId": product.id,
      "displayName": product.displayName,
      "description": product.description,
      "displayPrice": product.displayPrice,
      "price": NSDecimalNumber(decimal: product.price).doubleValue,
      "currencyCode": product.priceFormatStyle.currencyCode,
      "hasIntroOffer": intro != nil,
      "introOfferLabel": label ?? NSNull(),
    ]
  }

  private static func purchaseDict(_ transaction: Transaction, jws: String) -> [String: Any] {
    [
      "productId": transaction.productID,
      "originalTransactionId": String(transaction.originalID),
      "transactionId": String(transaction.id),
      "signedTransactionInfo": jws,
      "environment": environmentString(transaction),
    ]
  }

  private static func environmentString(_ transaction: Transaction) -> String {
    if #available(iOS 16.0, *) {
      switch transaction.environment {
      case .production: return "Production"
      case .sandbox: return "Sandbox"
      case .xcode: return "Xcode"
      default: return "Unknown"
      }
    }
    // Transaction.environment is iOS 16+; deployment target is 15.1.
    return "Unknown"
  }

  /// Human-readable intro copy for the purchase disclosure, not a legal string.
  private static func introOfferLabel(for offer: Product.SubscriptionOffer) -> String {
    let period = periodLabel(offer.period)
    switch offer.paymentMode {
    case .freeTrial:
      return "\(period) free"
    case .payAsYouGo, .payUpFront:
      return "\(offer.displayPrice) for \(period)"
    default:
      return offer.displayPrice
    }
  }

  private static func periodLabel(_ period: Product.SubscriptionPeriod) -> String {
    let n = period.value
    switch period.unit {
    case .day: return n == 1 ? "1 day" : "\(n) days"
    case .week: return n == 1 ? "1 week" : "\(n) weeks"
    case .month: return n == 1 ? "1 month" : "\(n) months"
    case .year: return n == 1 ? "1 year" : "\(n) years"
    @unknown default: return "\(n)"
    }
  }

  private static func reject(
    _ reject: (String?, String?, Error?) -> Void,
    code: String,
    error: Error
  ) {
    if let bridge = error as? StoreKitBridgeError {
      reject(bridge.code, bridge.message, error)
      return
    }
    reject(code, error.localizedDescription, error)
  }
}

private enum StoreKitBridgeError: Error {
  case productNotFound(String)

  var code: String {
    switch self {
    case .productNotFound: return "product_not_found"
    }
  }

  var message: String {
    switch self {
    case .productNotFound(let id):
      return "Product \(id) was not found in the App Store."
    }
  }
}
