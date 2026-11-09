package com.mctb.autoreply.ui

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * Whether the user has granted `ROLE_CALL_SCREENING`.
 *
 * Recomputed on every resume, because the grant happens in a *system* dialog
 * outside this app - there is no result callback that fires on the way back, so
 * observing the lifecycle is the only reliable way to notice.
 */
@Composable
fun rememberCallScreeningRoleHeld(): Boolean {
    val context = LocalContext.current
    var held by remember { mutableStateOf(isCallScreeningRoleHeld(context)) }
    val lifecycleOwner = LocalLifecycleOwner.current

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                held = isCallScreeningRoleHeld(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    return held
}

fun isCallScreeningRoleHeld(context: Context): Boolean {
    val roleManager = context.getSystemService(RoleManager::class.java) ?: return false
    return roleManager.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) &&
        roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
}

/**
 * Intent for the system "let this app screen calls?" dialog, or `null` when the
 * role is already held or unavailable on this device.
 */
fun createCallScreeningRoleRequestIntent(context: Context): Intent? {
    val roleManager = context.getSystemService(RoleManager::class.java) ?: return null
    if (!roleManager.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)) return null
    if (roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) return null
    return roleManager.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
}
