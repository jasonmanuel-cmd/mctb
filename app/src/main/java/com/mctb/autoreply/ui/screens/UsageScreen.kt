package com.mctb.autoreply.ui.screens

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.mctb.autoreply.R
import com.mctb.autoreply.billing.BillingManager
import com.mctb.autoreply.billing.UnlockOffer
import com.mctb.autoreply.data.AppPreferences
import com.mctb.autoreply.data.Quota
import kotlinx.coroutines.flow.MutableStateFlow

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageScreen(navController: NavController) {
    val context = LocalContext.current
    val prefs = remember { AppPreferences(context) }

    val replyCount by prefs.replyCount.collectAsState(initial = 0)
    val alreadyUnlimited by prefs.isUnlimited.collectAsState(initial = false)
    val quota = remember(replyCount, alreadyUnlimited) { Quota(replyCount, alreadyUnlimited) }

    // Billing needs an Activity. If we somehow cannot find one, fall back to a
    // static "unavailable" offer rather than crashing the screen.
    val activity = remember(context) { context.findActivity() }
    // remember on both: the manager holds a coroutine scope and a billing
    // connection, so it must not be rebuilt on every recomposition.
    val billing = remember(activity, prefs) {
        activity?.let { BillingManager(it, prefs) }
    }
    val offerFlow = remember(billing) {
        billing?.offer ?: MutableStateFlow<UnlockOffer>(
            UnlockOffer.Unavailable("no activity")
        )
    }
    val offer by offerFlow.collectAsState()

    DisposableEffect(billing) {
        billing?.start()
        onDispose { billing?.release() }
    }

    // Mirror an owned entitlement into local storage so the background path
    // stops applying the free-tier cap even if Play is unreachable later.
    LaunchedEffect(offer) {
        if (offer is UnlockOffer.Owned && !alreadyUnlimited) {
            prefs.setUnlimited(true)
        }
    }

    Scaffold(
        topAppBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.usage_title)) },
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
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            QuotaCard(quota = quota)

            when (val current = offer) {
                is UnlockOffer.Owned -> OwnedCard(onRestore = { billing?.restoreExistingPurchase() })

                is UnlockOffer.Purchasable -> PurchaseCard(
                    price = current.formattedPrice,
                    onBuy = { billing?.launchPurchase() }
                )

                is UnlockOffer.Loading -> LoadingCard()

                is UnlockOffer.Unavailable -> UnavailableCard(onRetry = { billing?.start() })
            }

            ServerCard(prefs = prefs)
        }
    }
}

/**
 * Where the reply server is, and this subscriber's token.
 *
 * Replies are sent by the server, so an upgrade bought here does nothing until
 * the server knows about it. These two values are what
 * [com.mctb.autoreply.billing.BillingManager] posts the purchase token with.
 */
@Composable
private fun ServerCard(prefs: AppPreferences) {
    val scope = rememberCoroutineScope()
    val savedUrl by prefs.serverBaseUrl.collectAsState(initial = "")
    val savedToken by prefs.apiToken.collectAsState(initial = "")

    var url by remember(savedUrl) { mutableStateOf(savedUrl) }
    var token by remember(savedToken) { mutableStateOf(savedToken) }
    var feedback by remember { mutableStateOf<String?>(null) }

    // stringResource is @Composable, so it cannot be called from the coroutine
    // below. Hoisted here instead.
    val savedMessage = stringResource(R.string.server_saved)
    val incompleteMessage = stringResource(R.string.server_incomplete)

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = stringResource(R.string.server_card_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = stringResource(R.string.server_card_body),
                style = MaterialTheme.typography.bodyMedium
            )

            OutlinedTextField(
                value = url,
                onValueChange = {
                    url = it
                    feedback = null
                },
                label = { Text(stringResource(R.string.server_url_label)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = token,
                onValueChange = {
                    token = it
                    feedback = null
                },
                label = { Text(stringResource(R.string.server_token_label)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )

            Button(
                onClick = {
                    if (url.isBlank() || token.isBlank()) {
                        feedback = incompleteMessage
                    } else {
                        scope.launch {
                            prefs.setServerConfig(url, token)
                            feedback = savedMessage
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.server_save))
            }

            feedback?.let {
                Text(text = it, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun QuotaCard(quota: Quota) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(
                text = when {
                    quota.isUnlimited -> stringResource(R.string.unlocked_title)
                    quota.isExhausted -> stringResource(R.string.limit_reached_title)
                    else -> stringResource(R.string.free_tier_title)
                },
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = when {
                    quota.isUnlimited -> stringResource(R.string.unlocked_desc)
                    quota.isExhausted -> stringResource(R.string.limit_reached_desc)
                    else -> stringResource(R.string.free_tier_desc)
                },
                style = MaterialTheme.typography.bodyMedium
            )

            if (!quota.isUnlimited) {
                Spacer(modifier = Modifier.height(12.dp))
                LinearProgressIndicator(
                    progress = { quota.used.toFloat() / quota.limit.toFloat() },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = stringResource(R.string.usage_count, quota.used, quota.limit),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun OwnedCard(onRestore: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.tertiaryContainer
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Default.CheckCircle, contentDescription = null)
                Text(
                    text = stringResource(R.string.purchase_thanks),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold
                )
            }
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedButton(onClick = onRestore) {
                Text(stringResource(R.string.restore_purchases))
            }
        }
    }
}

@Composable
private fun PurchaseCard(price: String?, onBuy: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(
                text = stringResource(R.string.upgrade_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.upgrade_desc),
                style = MaterialTheme.typography.bodyMedium
            )
            Spacer(modifier = Modifier.height(16.dp))
            Button(onClick = onBuy, modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = if (price != null) {
                        stringResource(R.string.upgrade_button_with_price, price)
                    } else {
                        stringResource(R.string.upgrade_button)
                    }
                )
            }
        }
    }
}

@Composable
private fun LoadingCard() {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CircularProgressIndicator(modifier = Modifier.height(24.dp))
            Text(
                text = stringResource(R.string.loading_offer),
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}

@Composable
private fun UnavailableCard(onRetry: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Default.Warning, contentDescription = null)
                Text(
                    text = stringResource(R.string.offer_unavailable_title),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.offer_unavailable_desc),
                style = MaterialTheme.typography.bodyMedium
            )
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
