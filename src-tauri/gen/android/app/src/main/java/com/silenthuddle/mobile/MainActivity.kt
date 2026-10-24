package com.silenthuddle.mobile

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts

class MainActivity : TauriActivity() {
  private var callWebView: WebView? = null

  private val requestMediaPermissions = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val permissions = mutableListOf(
      Manifest.permission.CAMERA,
      Manifest.permission.RECORD_AUDIO
    )
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
      permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      permissions.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    requestMediaPermissions.launch(permissions.toTypedArray())
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    callWebView = webView
  }

  override fun onPause() {
    super.onPause()
    // O Wry pausa o WebView por padrão. Em uma chamada ativa, retomamos apenas
    // o motor de mídia para que WebRTC não seja encerrado ao trocar de app.
    if (CallRuntimeState.active) callWebView?.onResume()
  }
}
