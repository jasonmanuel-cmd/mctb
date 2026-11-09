package com.mctb.autoreply.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Dialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberTimePickerState
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
import androidx.navigation.NavController
import com.mctb.autoreply.R
import com.mctb.autoreply.data.AppPreferences
import com.mctb.autoreply.domain.ActiveHours
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActiveHoursScreen(navController: NavController) {
    val context = LocalContext.current
    val prefs = remember { AppPreferences(context) }
    val scope = rememberCoroutineScope()

    val savedAlwaysOn by prefs.isAlwaysOn.collectAsState(initial = false)
    val savedStart by prefs.startMinuteOfDay.collectAsState(
        initial = ActiveHours.minuteOfDay(
            AppPreferences.DEFAULT_START_HOUR,
            AppPreferences.DEFAULT_START_MINUTE
        )
    )
    val savedEnd by prefs.endMinuteOfDay.collectAsState(
        initial = ActiveHours.minuteOfDay(
            AppPreferences.DEFAULT_END_HOUR,
            AppPreferences.DEFAULT_END_MINUTE
        )
    )

    var alwaysOn by remember { mutableStateOf(savedAlwaysOn) }
    var startMinute by remember { mutableStateOf(savedStart) }
    var endMinute by remember { mutableStateOf(savedEnd) }

    /** Seeds the local buffer once the stored values arrive. */
    var initialized by remember { mutableStateOf(false) }
    LaunchedEffect(savedAlwaysOn, savedStart, savedEnd) {
        if (!initialized) {
            alwaysOn = savedAlwaysOn
            startMinute = savedStart
            endMinute = savedEnd
            initialized = true
        }
    }

    var showStartPicker by remember { mutableStateOf(false) }
    var showEndPicker by remember { mutableStateOf(false) }

    Scaffold(
        topAppBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.active_hours_title)) },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.back)
                        )
                    }
                }
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.padding(end = 16.dp)) {
                        Text(
                            text = stringResource(R.string.always_active),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = stringResource(R.string.always_active_desc),
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                    Switch(checked = alwaysOn, onCheckedChange = { alwaysOn = it })
                }
            }

            if (!alwaysOn) {
                Text(
                    text = stringResource(R.string.active_hours_desc),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                TimeField(
                    label = stringResource(R.string.start_time),
                    minuteOfDay = startMinute,
                    onClick = { showStartPicker = true }
                )

                TimeField(
                    label = stringResource(R.string.end_time),
                    minuteOfDay = endMinute,
                    onClick = { showEndPicker = true }
                )

                Text(
                    text = stringResource(R.string.same_time_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(modifier = Modifier.weight(1f))

            Button(
                onClick = {
                    scope.launch {
                        prefs.setAlwaysOn(alwaysOn)
                        if (!alwaysOn) {
                            prefs.setActiveHours(startMinute, endMinute)
                        }
                        navController.popBackStack()
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.save))
            }
        }
    }

    if (showStartPicker) {
        TimePickerDialog(
            title = stringResource(R.string.start_time),
            initialMinuteOfDay = startMinute,
            onDismiss = { showStartPicker = false },
            onConfirm = { minutes ->
                startMinute = minutes
                showStartPicker = false
            }
        )
    }

    if (showEndPicker) {
        TimePickerDialog(
            title = stringResource(R.string.end_time),
            initialMinuteOfDay = endMinute,
            onDismiss = { showEndPicker = false },
            onConfirm = { minutes ->
                endMinute = minutes
                showEndPicker = false
            }
        )
    }
}

@Composable
private fun TimeField(label: String, minuteOfDay: Int, onClick: () -> Unit) {
    Column {
        Text(
            text = label,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold
        )
        Spacer(modifier = Modifier.height(8.dp))
        OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
            Text(text = formatMinute(minuteOfDay), style = MaterialTheme.typography.titleLarge)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimePickerDialog(
    title: String,
    initialMinuteOfDay: Int,
    onDismiss: () -> Unit,
    onConfirm: (Int) -> Unit
) {
    val safeMinute = initialMinuteOfDay.coerceIn(0, ActiveHours.MINUTES_IN_DAY - 1)
    val state = rememberTimePickerState(
        initialHour = safeMinute / 60,
        initialMinute = safeMinute % 60,
        is24Hour = true
    )

    Dialog(onDismissRequest = onDismiss) {
        Card {
            Column(
                modifier = Modifier.padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(text = title, style = MaterialTheme.typography.titleMedium)
                Spacer(modifier = Modifier.height(16.dp))
                TimePicker(state = state)
                Spacer(modifier = Modifier.height(16.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    TextButton(onClick = onDismiss) {
                        Text(stringResource(R.string.cancel))
                    }
                    TextButton(
                        onClick = {
                            onConfirm(ActiveHours.minuteOfDay(state.hour, state.minute))
                        }
                    ) {
                        Text(stringResource(R.string.ok))
                    }
                }
            }
        }
    }
}
