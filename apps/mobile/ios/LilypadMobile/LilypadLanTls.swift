import Foundation
import CryptoKit
import Network
import React

/**
 * TLS certificate pinning for the desktop's LAN control plane
 * ([ADR-0006](../../../../docs/adr/0006-lan-first-connectivity.md)).
 */
@objc(LilypadLanTls)
class LilypadLanTls: RCTEventEmitter, URLSessionDelegate, URLSessionWebSocketDelegate {

  private var sessions: [Int: URLSession] = [:]
  private var webSockets: [Int: URLSessionWebSocketTask] = [:]
  private var delegates: [Int: WebSocketPinningDelegate] = [:]
  private var nextSocketId = 1
  private let lock = NSLock()

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    ["LanTlsWebSocketOpen", "LanTlsWebSocketMessage", "LanTlsWebSocketClose"]
  }

  // MARK: - Pinned HTTP

  @objc func fetch(
    _ urlString: String,
    expectedSha256: String,
    method: String,
    headers: [String: String],
    body: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = URL(string: urlString) else {
      reject("bad_url", "Invalid URL.", nil)
      return
    }
    let delegate = PinningDelegate(expectedSha256: expectedSha256.lowercased())
    let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    var request = URLRequest(url: url)
    request.httpMethod = method
    for (k, v) in headers {
      request.setValue(v, forHTTPHeaderField: k)
    }
    if let body, !body.isEmpty {
      request.httpBody = body.data(using: .utf8)
    }
    let task = session.dataTask(with: request) { data, response, error in
      if let error {
        reject("fetch_failed", error.localizedDescription, error)
        return
      }
      guard let http = response as? HTTPURLResponse else {
        reject("fetch_failed", "No HTTP response.", nil)
        return
      }
      let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      resolve([
        "status": http.statusCode,
        "body": text,
      ])
    }
    task.resume()
  }

  // MARK: - Pinned WebSocket

  @objc func connectWebSocket(
    _ urlString: String,
    expectedSha256: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = URL(string: urlString) else {
      reject("bad_url", "Invalid URL.", nil)
      return
    }
    let socketId = allocSocketId()
    let wsDelegate = WebSocketPinningDelegate(
      emitter: self,
      socketId: socketId,
      expectedSha256: expectedSha256.lowercased()
    )
    let session = URLSession(configuration: .ephemeral, delegate: wsDelegate, delegateQueue: OperationQueue())
    lock.lock()
    sessions[socketId] = session
    delegates[socketId] = wsDelegate
    lock.unlock()

    let task = session.webSocketTask(with: url)
    lock.lock()
    webSockets[socketId] = task
    lock.unlock()
    task.resume()
    resolve(socketId)
  }

  @objc func sendWebSocket(_ socketId: NSNumber, text: String) {
    let id = socketId.intValue
    lock.lock()
    let task = webSockets[id]
    lock.unlock()
    task?.send(.string(text)) { _ in }
  }

  @objc func closeWebSocket(_ socketId: NSNumber) {
    let id = socketId.intValue
    lock.lock()
    let task = webSockets.removeValue(forKey: id)
    let session = sessions.removeValue(forKey: id)
    delegates.removeValue(forKey: id)
    lock.unlock()
    task?.cancel(with: .goingAway, reason: nil)
    session?.invalidateAndCancel()
  }

  /// Browse `_lilypad._tcp` for a desktop matching `desktopDeviceId` (TXT record).
  @objc func browseLilypad(
    _ desktopDeviceId: String,
    timeoutMs: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let helper = LilypadBonjourBrowse(
        targetDeviceId: desktopDeviceId,
        timeoutMs: timeoutMs.intValue,
        resolve: resolve,
        reject: reject
      )
      helper.start()
    }
  }

  private func allocSocketId() -> Int {
    lock.lock()
    defer { lock.unlock() }
    let id = nextSocketId
    nextSocketId += 1
    return id
  }
}

// MARK: - HTTP pinning

private final class PinningDelegate: NSObject, URLSessionDelegate {
  let expectedSha256: String
  init(expectedSha256: String) { self.expectedSha256 = expectedSha256 }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust,
          let cert = SecTrustGetCertificateAtIndex(trust, 0) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let der = SecCertificateCopyData(cert) as Data
    let hash = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    if hash == expectedSha256 {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }
}

// MARK: - WebSocket pinning + receive loop

private final class WebSocketPinningDelegate: NSObject, URLSessionWebSocketDelegate, URLSessionDelegate {
  weak var emitter: LilypadLanTls?
  let socketId: Int
  let expectedSha256: String

  init(emitter: LilypadLanTls, socketId: Int, expectedSha256: String) {
    self.emitter = emitter
    self.socketId = socketId
    self.expectedSha256 = expectedSha256
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust,
          let cert = SecTrustGetCertificateAtIndex(trust, 0) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let der = SecCertificateCopyData(cert) as Data
    let hash = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    if hash == expectedSha256 {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    emitter?.sendEvent(withName: "LanTlsWebSocketOpen", body: ["socketId": socketId])
    receiveNext(on: webSocketTask)
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    emitter?.sendEvent(withName: "LanTlsWebSocketClose", body: ["socketId": socketId])
  }

  private func receiveNext(on task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.string(let text)):
        self.emitter?.sendEvent(withName: "LanTlsWebSocketMessage", body: ["socketId": self.socketId, "data": text])
        self.receiveNext(on: task)
      case .success(.data(let data)):
        if let text = String(data: data, encoding: .utf8) {
          self.emitter?.sendEvent(withName: "LanTlsWebSocketMessage", body: ["socketId": self.socketId, "data": text])
        }
        self.receiveNext(on: task)
      case .failure:
        self.emitter?.sendEvent(withName: "LanTlsWebSocketClose", body: ["socketId": self.socketId])
      }
    }
  }
}

// MARK: - Bonjour browse (mDNS step 2, NETWORKING.md §3)

private final class LilypadBonjourBrowse: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  private let targetDeviceId: String
  private let timeoutMs: Int
  private let resolve: RCTPromiseResolveBlock
  private let reject: RCTPromiseRejectBlock
  private var browser: NetServiceBrowser?
  private var finished = false

  init(
    targetDeviceId: String,
    timeoutMs: Int,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    self.targetDeviceId = targetDeviceId
    self.timeoutMs = timeoutMs
    self.resolve = resolve
    self.reject = reject
  }

  func start() {
    let b = NetServiceBrowser()
    b.delegate = self
    browser = b
    b.searchForServices(ofType: "_lilypad._tcp.", inDomain: "local.")
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
      self?.finish(with: NSNull())
    }
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    service.delegate = self
    service.resolve(withTimeout: 2)
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    guard let txt = sender.txtRecordData(),
          let dict = NetService.dictionary(fromTXTRecord: txt) as? [String: Data],
          let idData = dict["deviceId"],
          let id = String(data: idData, encoding: .utf8),
          id == targetDeviceId,
          let host = sender.hostName,
          sender.port > 0 else {
      return
    }
    var trimmed = host
    if trimmed.hasSuffix(".") { trimmed.removeLast() }
    finish(with: [
      "host": trimmed,
      "port": sender.port,
      "deviceId": id,
    ] as [String: Any])
  }

  private func finish(with value: Any) {
    guard !finished else { return }
    finished = true
    browser?.stop()
    browser = nil
    resolve(value)
  }
}
