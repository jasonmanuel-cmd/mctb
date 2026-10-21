package com.mctb.autoreply.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.mctb.autoreply.ui.screens.ActiveHoursScreen
import com.mctb.autoreply.ui.screens.HomeScreen
import com.mctb.autoreply.ui.screens.HowItWorksScreen
import com.mctb.autoreply.ui.screens.MessageEditorScreen
import com.mctb.autoreply.ui.screens.UsageScreen
import com.mctb.autoreply.ui.theme.AppTheme

/**
 * Single-activity host for the Compose UI.
 *
 * There is deliberately no foreground service behind this app any more: call
 * state arrives through a manifest-declared receiver, which the system wakes
 * from a dead process. See [com.mctb.autoreply.receiver.PhoneStateReceiver].
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            AppTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val navController = rememberNavController()

                    NavHost(navController = navController, startDestination = ROUTE_HOME) {
                        composable(ROUTE_HOME) { HomeScreen(navController) }
                        composable(ROUTE_MESSAGE_EDITOR) { MessageEditorScreen(navController) }
                        composable(ROUTE_ACTIVE_HOURS) { ActiveHoursScreen(navController) }
                        composable(ROUTE_USAGE) { UsageScreen(navController) }
                        composable(ROUTE_HOW_IT_WORKS) { HowItWorksScreen(navController) }
                    }
                }
            }
        }
    }

    private companion object {
        const val ROUTE_HOME = "home"
        const val ROUTE_MESSAGE_EDITOR = "message_editor"
        const val ROUTE_ACTIVE_HOURS = "active_hours"
        const val ROUTE_USAGE = "usage"
        const val ROUTE_HOW_IT_WORKS = "how_it_works"
    }
}
