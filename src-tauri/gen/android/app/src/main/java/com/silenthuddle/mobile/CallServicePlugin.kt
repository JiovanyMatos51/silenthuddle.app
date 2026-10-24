package com.silenthuddle.mobile

import android.app.Activity
import android.content.Intent
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SetCallServiceArgs {
  var active: Boolean = false
  var cameraActive: Boolean = false
}

@TauriPlugin
class CallServicePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setActive(invoke: Invoke) {
    val args = invoke.parseArgs(SetCallServiceArgs::class.java)
    activity.runOnUiThread {
      try {
        CallRuntimeState.active = args.active
        CallRuntimeState.cameraActive = args.cameraActive
        val intent = Intent(activity, CallForegroundService::class.java).apply {
          putExtra(CallForegroundService.EXTRA_CAMERA_ACTIVE, args.cameraActive)
        }
        if (args.active) {
          ContextCompat.startForegroundService(activity, intent)
        } else {
          activity.stopService(intent)
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not update the call service")
      }
    }
  }
}
