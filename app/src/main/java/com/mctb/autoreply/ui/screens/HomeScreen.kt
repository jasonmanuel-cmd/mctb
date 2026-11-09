package com.mctb.autoreply.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.navigation.NavController
import com.mctb.autoreply.R
import com.mctb.autoreply.data.AppPreferences
import com.mctb.autoreply.data.Quota
import com.mctb.autoreply.createCallScreeningRoleRequestIntent
import com.mctb.autoreply.rememberCallScreeningRoleHeld
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(navController: NavController) {
    val context = LocalContext.current
    val prefs = remember { AppPreferences(context) }
    val scope = rememberCoroutineScope()

    val isEnabled by prefs.isEnabled.collectAsState(initial = false)
    val replyCount by prefs.replyCount.collectAsState(initial = 0)
    val isUnlimited by prefs.isUnlimited.collectAsState(initial = false)
    val alwaysOn by prefs.isAlwaysOn.collectAsState(initial = false)
    val startMinute by prefs.startMinuteOfDay.collectAsState(
        initial = AppPreferences.DEFAULT_START_HOUR * 60
    )
    val endMinute by prefs.endMinuteOfDay.collectAsState(
        initial = AppPreferences.DEFAULT_END_HOUR * 60
    )

    val quota = remember(replyCount, isUnlimited) { Quota(replyCount, isUnlimited) }

    val roleHeld = rememberCallScreeningRoleHeld()

    var notificationsGranted by remember {
        mutableStateOf(areNotificationsPermitted(context))
    }
    var showLimitDialog by remember { mutableStateOf(false) }

    /**
     * Set when the user flips the switch while a grant is still outstanding, so
     * enabling completes by itself once the grant lands. Without this the switch
     * would silently do nothing and the user would have to notice and retry.
     */
    var pendingEnable by remember { mutableStateOf(false) }

    val notificationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        notificationsGranted = granted
    }

    val roleLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        // Result is ignored; the role state is re-read on resume.
    }

    val setupComplete = roleHeld && notificationsGranted

    // Finish the enable the user already asked for, now that access was granted.
    LaunchedEffect(setupComplete, pendingEnable) {
        if (pendingEnable && setupComplete) {
            pendingEnable = false
            prefs.setEnabled(true)
        }
    }

    Scaffold(
        topAppBar = { TopAppBar(title = { Text(stringResource(R.string.app_name)) }) }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            if (!setupComplete) {
                SetupCard(
                    roleHeld = roleHeld,
                    notificationsGranted = notificationsGranted,
                    onRequestRole = {
                        createCallScreeningRoleRequestIntent(context)?.let(roleLauncher::launch)
                    },
                    onRequestNotifications = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    }
                )
            }

            StatusCard(
                isEnabled = isEnabled,
                alwaysOn = alwaysOn,
                startMinuteOfDay = startMinute,
                endMinuteOfDay = endMinute
            )

            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer
                )
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = stringResource(R.string.enable_auto_reply),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Switch(
                        checked = isEnabled,
                        onCheckedChange = { enabled ->
                            if (!enabled) {
                                scope.launch { prefs.setEnabled(false) }
                                return@Switch
                            }
                            if (quota.isExhausted) {
                                showLimitDialog = true
                                return@Switch
                            }
                            if (!setupComplete) {
                                pendingEnable = true
                                if (!roleHeld) {
                                    createCallScreeningRoleRequestIntent(context)
                                        ?.let(roleLauncher::launch)
                                } else {
                                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                        notificationLauncher
                                            .launch(Manifest.permission.POST_NOTIFICATIONS)
                                    }
                                }
                                return@Switch
                            }
                            scope.launch { prefs.setEnabled(true) }
                        }
                    )
                }
            }

            UsageCard(quota = quota, onViewUsageClick = { navController.navigate("usage") })

            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                FilledTonalButton(
                    onClick = { navController.navigate("message_editor") },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Default.Edit, contentDescription = null)
                    Spacer(modifier = Modifier.padding(4.dp))
                    Text(stringResource(R.string.configure_message))
                }

                FilledTonalButton(
                    onClick = { navController.navigate("active_hours") },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Default.Schedule, contentDescription = null)
                    Spacer(modifier = Modifier.padding(4.dp))
                    Text(stringResource(R.string.configure_hours))
                }

                FilledTonalButton(
                    onClick = { navController.navigate("how_it_works") },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Default.HelpOutline, contentDescription = null)
                    Spacer(modifier = Modifier.padding(4.dp))
                    Text(stringResource(R.string.how_it_works_title))
                }
            }
        }
    }

    if (showLimitDialog) {
        AlertDialog(
            onDismissRequest = { showLimitDialog = false },
            title = { Text(stringResource(R.string.limit_reached_title)) },
            text = { Text(stringResource(R.string.limit_reached_desc)) },
            confirmButton = {
                TextButton(onClick = {
                    showLimitDialog = false
                    navController.navigate("usage")
                }) {
                    Text(stringResource(R.string.upgrade_button))
                }
            },
            dismissButton = {
                TextButton(onClick = { showLimitDialog = false }) {
                    Text(stringResource(R.string.cancel))
                }
            }
        )
    }
}

private fun areNotificationsPermitted(context: android.content.Context): Boolean =
    ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.POST_NOTIFICATIONS
    ) == PackageManager.PERMISSION_GRANTED

@Composable
private fun StatusCard(
    isEnabled: Boolean,
    alwaysOn: Boolean,
    startMinuteOfDay: Int,
    endMinuteOfDay: Int
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isEnabled) {
                MaterialTheme.colorScheme.tertiaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            }
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(
                imageVector = if (isEnabled) Icons.Default.Check else Icons.Default.Close,
                contentDescription = null,
                tint = if (isEnabled) {
                    MaterialTheme.colorScheme.onTertiaryContainer
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                }
            )
            Column {
                Text(
                    text = if (isEnabled) {
                        stringResource(R.string.status_active)
                    } else {
                        stringResource(R.string.status_inactive)
                    },
                    style = MaterialTheme.typography.bodyLarge
                )
                if (isEnabled) {
                    Text(
                        text = if (alwaysOn) {
                            stringResource(R.string.status_window_always)
                        } else {
                            stringResource(
                                R.string.status_window_between,
                                formatMinute(startMinuteOfDay),
                                formatMinute(endMinuteOfDay)
                            )
                        },
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        }
    }
}

@Composable
private fun SetupCard(
    roleHeld: Boolean,
    notificationsGranted: Boolean,
    onRequestRole: () -> Unit,
    onRequestNotifications: () -> Unit
) {
    OutlinedCard(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.outlinedCardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Icon(
                    Icons.Default.Warning,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onErrorContainer
                )
                Text(
                    text = stringResource(R.string.setup_required_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = stringResource(R.string.setup_required_desc),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer
            )

            Spacer(modifier = Modifier.height(12.dp))

            SetupRow(
                done = roleHeld,
                label = stringResource(R.string.setup_step_call_screening),
                actionLabel = stringResource(R.string.setup_step_grant),
                onAction = onRequestRole
            )

            SetupRow(
                done = notificationsGranted,
                label = stringResource(R.string.setup_step_notifications),
                actionLabel = stringResource(R.string.setup_step_grant),
                onAction = onRequestNotifications
            )
        }
    }
}

@Composable
private fun SetupRow(done: Boolean, label: String, actionLabel: String, onAction: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Icon(
                imageVector = if (done) Icons.Default.Check else Icons.Default.Close,
                contentDescription = null
            )
            Text(text = label, style = MaterialTheme.typography.bodyMedium)
        }
        if (!done) {
            TextButton(onClick = onAction) { Text(actionLabel) }
        }
    }
}

@Composable
private fun UsageCard(quota: Quota, onViewUsageClick: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(
                text = stringResource(R.string.usage_label),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))

            if (quota.isUnlimited) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null)
                    Text(
                        text = stringResource(R.string.usage_unlimited),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            } else {
                Text(
                    text = stringResource(R.string.usage_count, quota.used, quota.limit),
                    style = MaterialTheme.typography.bodyLarge
                )
                Spacer(modifier = Modifier.height(8.dp))
                LinearProgressIndicator(
                    progress = { quota.used.toFloat() / quota.limit.toFloat() },
                    modifier = Modifier.fillMaxWidth()
                )
            }

            Spacer(modifier = Modifier.height(8.dp))
            TextButton(onClick = onViewUsageClick) {
                Text(stringResource(R.string.view_usage))
            }
        }
    }
}

/** 1305 -> "21:45". */
internal fun formatMinute(minuteOfDay: Int): String {
    val safe = minuteOfDay.coerceIn(0, 24 * 60 - 1)
    return "%02d:%02d".format(safe / 60, safe % 60)
}
