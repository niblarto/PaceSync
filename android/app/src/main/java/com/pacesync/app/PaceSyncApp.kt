package com.pacesync.app

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
//
// Schedule is listed/started first (per explicit user request) — it's the
// forward-looking "what's coming up" view, treated as the app's default
// landing tab instead of Summary (the backward-looking history view).
private sealed class Dest(val route: String, val label: String) {
    data object Schedule : Dest("schedule", "Schedule")
    data object Summary : Dest("summary", "Summary")
    data object Settings : Dest("settings", "Settings")
}

// Settings is reached via the top-bar cog (top right), not a bottom tab —
// per explicit user request.
private val bottomDestinations = listOf(Dest.Schedule, Dest.Summary)

@OptIn(ExperimentalMaterial3Api::class)
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
    // A static title bar is only meaningful on the bottom-tab screens — the
    // detail/picker/chart screens either have their own in-content heading
    // or (Pace Chart) deliberately have no header at all to save vertical
    // space on a cramped landscape layout.
    val topBarTitle = when {
        currentRoute == Dest.Schedule.route -> "Schedule"
        currentRoute == Dest.Summary.route -> "Summary"
        currentRoute == Dest.Settings.route -> "Settings"
        else -> null
    }

    Scaffold(
        topBar = {
            if (topBarTitle != null) {
                TopAppBar(
                    title = { Text(topBarTitle) },
                    actions = {
                        if (currentRoute != Dest.Settings.route) {
                            IconButton(onClick = {
                                navController.navigate(Dest.Settings.route) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            }) {
                                Icon(Icons.Filled.Settings, contentDescription = "Settings")
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                )
            }
        },
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
                                        else -> Icons.Filled.Settings
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
            startDestination = Dest.Schedule.route,
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
                PaceChartScreen(container.api, container.mixBuildClient, date = date, title = title) {
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
