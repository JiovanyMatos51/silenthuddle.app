package com.silenthuddle.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

object CallRuntimeState {
  @Volatile
  var active: Boolean = false

  @Volatile
  var cameraActive: Boolean = false
}

class CallForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!CallRuntimeState.active) {
      stopSelf()
      return START_NOT_STICKY
    }

    CallRuntimeState.cameraActive = intent?.getBooleanExtra(
      EXTRA_CAMERA_ACTIVE,
      CallRuntimeState.cameraActive
    ) ?: CallRuntimeState.cameraActive
    var serviceTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    if (CallRuntimeState.cameraActive) {
      serviceTypes = serviceTypes or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    }
    ServiceCompat.startForeground(this, NOTIFICATION_ID, createNotification(), serviceTypes)
    acquireWakeLock()
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTaskRemoved(rootIntent: Intent?) {
    CallRuntimeState.active = false
    CallRuntimeState.cameraActive = false
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = powerManager.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "SilentHuddle:ActiveCall"
    ).apply { acquire() }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "SilentHuddle calls",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Keeps an active SilentHuddle call connected"
      setSound(null, null)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun createNotification(): Notification {
    val launchIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("SilentHuddle")
      .setContentText("Call in progress")
      .setContentIntent(pendingIntent)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "silenthuddle-active-call"
    private const val NOTIFICATION_ID = 1301
    const val EXTRA_CAMERA_ACTIVE = "cameraActive"
  }
}
