package com.takedia.lilypad

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import okhttp3.*
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * LAN TLS pinning + mDNS browse for the desktop control plane (ADR-0006).
 */
class LilypadLanModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val nsd = reactContext.getSystemService(NsdManager::class.java)
  private val clients = mutableMapOf<Int, OkHttpClient>()
  private val websockets = mutableMapOf<Int, WebSocket>()
  private var nextSocketId = 1

  override fun getName(): String = "LilypadLanTls"

  @ReactMethod
  fun fetch(
    url: String,
    expectedSha256: String,
    method: String,
    headers: ReadableMap,
    body: String?,
    promise: Promise,
  ) {
    try {
      val client = pinnedClient(expectedSha256)
      val builder = Request.Builder().url(url).method(method, body?.toRequestBody())
      val iter = headers.keySetIterator()
      while (iter.hasNextKey()) {
        val key = iter.nextKey()
        headers.getString(key)?.let { builder.header(key, it) }
      }
      client.newCall(builder.build()).enqueue(
        object : Callback {
          override fun onFailure(call: Call, e: java.io.IOException) {
            promise.reject("fetch_failed", e.message, e)
          }

          override fun onResponse(call: Call, response: Response) {
            val text = response.body?.string() ?: ""
            promise.resolve(
              Arguments.createMap().apply {
                putInt("status", response.code)
                putString("body", text)
              },
            )
          }
        },
      )
    } catch (e: Exception) {
      promise.reject("fetch_failed", e.message, e)
    }
  }

  @ReactMethod
  fun connectWebSocket(url: String, expectedSha256: String, promise: Promise) {
    try {
      val id = nextSocketId++
      val client = pinnedClient(expectedSha256)
      clients[id] = client
      val ws =
        client.newWebSocket(
          Request.Builder().url(url).build(),
          object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
              emit("LanTlsWebSocketOpen", id)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
              emit("LanTlsWebSocketMessage", id, text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
              emit("LanTlsWebSocketClose", id)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
              emit("LanTlsWebSocketClose", id)
            }
          },
        )
      websockets[id] = ws
      promise.resolve(id)
    } catch (e: Exception) {
      promise.reject("ws_failed", e.message, e)
    }
  }

  @ReactMethod
  fun sendWebSocket(socketId: Int, text: String) {
    websockets[socketId]?.send(text)
  }

  @ReactMethod
  fun closeWebSocket(socketId: Int) {
    websockets.remove(socketId)?.close(1000, "closed")
    clients.remove(socketId)
  }

  @ReactMethod
  fun browseLilypad(desktopDeviceId: String, timeoutMs: Int, promise: Promise) {
    if (nsd == null) {
      promise.resolve(null)
      return
    }
    val resolved = AtomicBoolean(false)
    lateinit var discoveryListener: NsdManager.DiscoveryListener
    discoveryListener =
      object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) {}

        override fun onServiceFound(info: NsdServiceInfo) {
          nsd.resolveService(
            info,
            object : NsdManager.ResolveListener {
              override fun onResolveFailed(s: NsdServiceInfo, code: Int) {}

              override fun onServiceResolved(s: NsdServiceInfo) {
                val id = s.attributes["deviceId"]?.let { String(it, Charsets.UTF_8) }
                if (id != desktopDeviceId || resolved.get()) return
                val host = s.host?.hostAddress ?: return
                if (resolved.compareAndSet(false, true)) {
                  try {
                    nsd.stopServiceDiscovery(discoveryListener)
                  } catch (_: Exception) {}
                  promise.resolve(
                    Arguments.createMap().apply {
                      putString("host", host)
                      putInt("port", s.port)
                      putString("deviceId", id)
                    },
                  )
                }
              }
            },
          )
        }

        override fun onServiceLost(info: NsdServiceInfo) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
          if (!resolved.get()) promise.resolve(null)
        }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      }
    nsd.discoverServices("_lilypad._tcp.", NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
      if (resolved.compareAndSet(false, true)) {
        try {
          nsd.stopServiceDiscovery(discoveryListener)
        } catch (_: Exception) {}
        promise.resolve(null)
      }
    }, timeoutMs.toLong())
  }

  private fun pinnedClient(expectedSha256: String): OkHttpClient {
    val trustManager =
      object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
          val der = chain.first().encoded
          val hash = MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }
          if (hash != expectedSha256.lowercase()) {
            throw CertificateException("pin mismatch")
          }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      }
    val ctx = SSLContext.getInstance("TLS")
    ctx.init(null, arrayOf(trustManager), null)
    return OkHttpClient.Builder()
      .sslSocketFactory(ctx.socketFactory, trustManager)
      .hostnameVerifier { _, _ -> true }
      .connectTimeout(10, TimeUnit.SECONDS)
      .build()
  }

  private fun emit(event: String, socketId: Int, data: String? = null) {
    val map = Arguments.createMap().apply {
      putInt("socketId", socketId)
      data?.let { putString("data", it) }
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, map)
  }
}

class LilypadLanPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(LilypadLanModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext) = emptyList<ViewManager<*, *>>()
}
