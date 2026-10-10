package com.pacesync.app

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.pacesync.app.data.AppContainer
import com.pacesync.app.ui.detail.ActivityDetailScreen
import com.pacesync.app.ui.detail.MixBuildScreen
import com.pacesync.app.ui.detail.PaceChartScreen
import com.pacesync.app.ui.detail.RoutePickerScreen
import com.pacesync.app.ui.schedule.ScheduleScreen
import com.pacesync.app.ui.settings.SettingsScreen
import com.pacesync.app.ui.summary.SummaryScreen
import java.net.URLDecoder
import java.net.URLEncoder

// No standalone Routes tab — a run's route is already reachable from its
// Summary/Schedule card via the activity-detail screen, so a separate
// course-picker tab was redundant (per explicit user request).
private sealed class Dest(val route: String, val label: String) {
    data object Summary : Dest("summary", "Summary")
    data object Schedule : Dest("schedule", "Schedule")
    data object Settings : Dest("settings", "Settings")
}

private val bottomDestinations = listOf(Dest.Summary, Dest.Schedule, Dest.Settings)

@Composable
fun PaceSyncApp(container: AppContainer) {
    val navController = rememberNavController()

    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    // Hidden on the Pace Chart screen — it's forced landscape and already
    // vertically cramped; the bottom nav was eating into the chart's own
    // space (confirmed from a real screenshot: the chip strip was pushed
    // under the nav bar) with nothing useful to offer there anyway (Back
    // already returns to the activity detail screen).
    val showBottomBar = currentRoute?.startsWith("pace-chart/") != true

    Scaffold(
        bottomBar = {
            if (showBottomBar) {
                NavigationBar {
                    bottomDestinations.forEach { dest ->
                        NavigationBarItem(
                            selected = backStackEntry?.destination?.hierarchy?.any { it.route == dest.route } == true,
                            onClick = {
                                navController.navigate(dest.route) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = {
                                Icon(
                                    when (dest) {
                                        Dest.Summary -> Icons.Filled.Home
                                        Dest.Schedule -> Icons.Filled.DateRange
                                        Dest.Settings -> Icons.Filled.Settings
                                    },
                                    contentDescription = dest.label,
                                )
                            },
                            label = { Text(dest.label) },
                        )
                    }
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Dest.Summary.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(Dest.Summary.route) {
                SummaryScreen(container.api) { date, title ->
                    navController.navigate("detail/$date/${URLEncoder.encode(title, "UTF-8")}")
                }
            }
            composable(Dest.Schedule.route) {
                ScheduleScreen(container.api) { date, title ->
                    navController.navigate("detail/$date/${URLEncoder.encode(title, "UTF-8")}")
                }
            }
            composable("detail/{date}/{title}") { backStackEntry ->
                val date = backStackEntry.arguments?.getString("date") ?: ""
                val title = URLDecoder.decode(backStackEntry.arguments?.getString("title") ?: "", "UTF-8")
                val encodedTitle = URLEncoder.encode(title, "UTF-8")
                ActivityDetailScreen(
                    container.api,
                    date = date,
                    title = title,
                    onPickRoute = { distanceMi -> navController.navigate("route-picker/$date/$encodedTitle/$distanceMi") },
                    onBuildMix = { navController.navigate("mix-build/$date/$encodedTitle") },
                    onShowPaceChart = { navController.navigate("pace-chart/$date/$encodedTitle") },
                )
            }
            composable("pace-chart/{date}/{title}") { backStackEntry ->
                val date = backStackEntry.arguments?.getString("date") ?: ""
                val title = URLDecoder.decode(backStackEntry.arguments?.getString("title") ?: "", "UTF-8")
                PaceChartScreen(container.api, date = date, title = title) {
                    navController.popBackStack()
                }
            }
            composable("route-picker/{date}/{title}/{distanceMi}") { backStackEntry ->
                val date = backStackEntry.arguments?.getString("date") ?: ""
                val title = URLDecoder.decode(backStackEntry.arguments?.getString("title") ?: "", "UTF-8")
                val distanceMi = backStackEntry.arguments?.getString("distanceMi")?.toDoubleOrNull() ?: 0.0
                RoutePickerScreen(container.api, date = date, title = title, distanceMi = distanceMi) {
                    navController.popBackStack()
                }
            }
            composable("mix-build/{date}/{title}") { backStackEntry ->
                val date = backStackEntry.arguments?.getString("date") ?: ""
                val title = URLDecoder.decode(backStackEntry.arguments?.getString("title") ?: "", "UTF-8")
                MixBuildScreen(container.api, container.mixBuildClient, date = date, title = title) {
                    navController.popBackStack()
                }
            }
            composable(Dest.Settings.route) { SettingsScreen(container.tokenStore, container.api) }
        }
    }
}
