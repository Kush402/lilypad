import Foundation
import React
import StoreKit

/**
 * Thin StoreKit 2 bridge for Lilypad Pro.

 * Classic `RCTBridgeModule` interop (via `LilypadStoreKit.m`) is deliberate:
 * New Architecture is on, but TurboModule codegen for a one-off StoreKit
 * surface would cost more than it buys, and the promise-based bridge is what
 * the TypeScript wrappers already speak.

 * Entitlement truth lives on the control plane after we POST the JWS.

 * ### Finishing is the receipt for delivery, not for the sale (L-297)

 * `purchase` used to call `transaction.finish()` before the JWS had been
 * anywhere near Lilypad's server. Finishing tells StoreKit "this is delivered,
 * stop redelivering it" — so losing the network, the process, or the backend in
 * the moments after a purchase left a person charged, with a transaction Apple
 * considered handed over and an account that had never heard of it. Recovery
 * meant the person somehow knowing to press Restore.

 * So nothing is finished here any more. `purchase` returns the signed
 * transaction and leaves it unfinished; JavaScript calls `finishTransaction`
 * only once the control plane has acknowledged it. Until then StoreKit itself
 * is the durable pending-delivery queue — it survives crashes, reinstalls and
 * reboots, which is more than any record we could keep — and `unfinished`
 * replays it on demand.

 * `Transaction.updates` is observed too, but only as a nudge: the event carries
 * no payload and the drain is what is authoritative. `RCTEventEmitter` drops an
 * event when nothing is listening yet, and a design where a dropped event costs
 * a delivery would be the same defect in a new place.
 */
@objc(LilypadStoreKit)
class LilypadStoreKit: RCTEventEmitter {

  // MARK: - RN bridge

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  /// A nudge, deliberately empty. See the note on `Transaction.updates` above.
  static let transactionsChanged = "LilypadStoreKitTransactionsChanged"

  private var updatesTask: Task<Void, Never>?

  override func supportedEvents() -> [String]! { [Self.transactionsChanged] }

  /**
   Watch Apple's stream of transactions that arrive outside a purchase call —
   an Ask-to-Buy approval that lands while the app is open, a renewal, a
   purchase made on another device.

   It tells JavaScript to drain; it does not carry the transaction. Anything
   missed while nothing was listening is still sitting in `Transaction.unfinished`
   for the next drain.
   */
  override func startObserving() {
    updatesTask?.cancel()
    updatesTask = Task { [weak self] in
      for await _ in Transaction.updates {
        guard !Task.isCancelled else { return }
        self?.sendEvent(withName: Self.transactionsChanged, body: nil)
      }
    }
  }

  override func stopObserving() {
    updatesTask?.cancel()
    updatesTask = nil
  }

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

  /**
   Buy, and stamp the purchase with the account it is for.

   `appAccountToken` is Apple's own answer to "whose purchase is this": it is
   carried inside the signed transaction, so it survives a reinstall, and the
   server can check it rather than taking the client's word. Without it, a
   delivery retried after a sign-out would be handed to whoever is signed in
   when it finally succeeds.

   Lilypad account ids are UUIDs, which is what the field requires. A caller
   that passes something else gets an unstamped purchase rather than no
   purchase -- the association is then whatever the server can work out on its
   own, exactly as before this existed.
   */
  @objc func purchase(
    _ productId: String,
    appAccountToken: String?,
    resolver resolve: @escaping (Any?) -> Void,
    rejecter reject: @escaping (String?, String?, Error?) -> Void
  ) {
    Task {
      do {
        let product = try await Self.fetchProduct(productId)
        var options: Set<Product.PurchaseOption> = []
        if let token = appAccountToken, let uuid = UUID(uuidString: token) {
          options.insert(.appAccountToken(uuid))
        }
        let result = try await product.purchase(options: options)
        switch result {
        case .success(let verification):
          // Deliberately NOT finished here. It stays in Transaction.unfinished
          // until the control plane has acknowledged it (L-297).
          let jws = verification.jwsRepresentation
          let transaction = try Self.unwrap(verification)
          resolve(Self.purchaseDict(transaction, jws: jws))
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

  /**
   Every transaction Apple still considers undelivered, newest work first.

   This is the recovery path: on launch, on foreground, and whenever the
   updates stream nudges. A purchase whose delivery failed is here, and stays
   here, until Lilypad acknowledges it.
   */
  @objc func unfinishedTransactions(
    _ resolve: @escaping (Any?) -> Void,
    rejecter reject: @escaping (String?, String?, Error?) -> Void
  ) {
    Task {
      var pending: [[String: Any]] = []
      for await verification in Transaction.unfinished {
        do {
          let jws = verification.jwsRepresentation
          let transaction = try Self.unwrap(verification)
          pending.append(Self.purchaseDict(transaction, jws: jws))
        } catch {
          // An unverified row cannot be delivered and must not block the
          // verified ones behind it.
          continue
        }
      }
      resolve(pending)
    }
  }

  /**
   Finish one transaction, by id, once Lilypad has recorded it.

   Resolves `false` when the transaction is no longer unfinished, which is not
   an error: a second delivery of the same purchase is the ordinary case, and
   the first one already finished it.
   */
  @objc func finishTransaction(
    _ transactionId: String,
    resolver resolve: @escaping (Any?) -> Void,
    rejecter reject: @escaping (String?, String?, Error?) -> Void
  ) {
    Task {
      for await verification in Transaction.unfinished {
        guard let transaction = try? Self.unwrap(verification) else { continue }
        if String(transaction.id) == transactionId {
          await transaction.finish()
          resolve(true)
          return
        }
      }
      resolve(false)
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
      // Whose purchase Apple was told this was, when it was told. Null for a
      // purchase made before the stamp existed, or one made outside the app.
      "appAccountToken": transaction.appAccountToken?.uuidString ?? NSNull(),
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
