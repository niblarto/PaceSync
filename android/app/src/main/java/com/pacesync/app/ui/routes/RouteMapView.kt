package com.pacesync.app.ui.routes

import android.graphics.Color as AndroidColor
import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.pacesync.app.network.dto.RoutePoint
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Polyline

private const val FIT_BORDER_PX = 64

// Shared polyline-on-OSM renderer, factored out of RouteMapScreen so the
// activity-detail screen (ui/detail/ActivityDetailScreen.kt) can embed the
// same map without duplicating the osmdroid setup/Polyline/bounding-box
// logic. Pass an empty list to get the "No GPS data" message.
@Composable
fun RouteMapView(points: List<RoutePoint>, modifier: Modifier = Modifier.fillMaxSize()) {
    val context = LocalContext.current
    if (points.isEmpty()) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text("No GPS data for this route.", color = MaterialTheme.colorScheme.secondary)
        }
        return
    }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            Configuration.getInstance().userAgentValue = context.packageName
            MapView(ctx).apply {
                setTileSource(TileSourceFactory.MAPNIK)
                setMultiTouchControls(true)
            }
        },
        update = { mapView ->
            // update runs on every recomposition — only rebuild/re-fit when
            // the route itself changes.
            if (mapView.tag === points) return@AndroidView
            mapView.tag = points
            val geoPoints = points.map { GeoPoint(it.lat, it.lng) }
            mapView.overlays.clear()
            mapView.overlays.add(
                Polyline().apply {
                    setPoints(geoPoints)
                    outlinePaint.color = AndroidColor.parseColor("#34D399") // emerald-400, matches app theme
                    outlinePaint.strokeWidth = 8f
                },
            )
            fitWhenLaidOut(mapView, BoundingBox.fromGeoPointsSafe(geoPoints))
            mapView.invalidate()
        },
        onRelease = { it.onDetach() },
    )
}

// osmdroid's zoomToBoundingBox spins forever (Projection.getCloserPixel)
// when the map has no real size yet or the box has zero span — confirmed
// as the cause of the app freezing/being killed (ANR) around the Pace
// Chart's rotation, which detaches and re-lays-out this view.
private fun fitWhenLaidOut(map: MapView, bbox: BoundingBox) {
    fun sized() = map.isAttachedToWindow && map.width > FIT_BORDER_PX * 2 && map.height > FIT_BORDER_PX * 2
    fun fit() {
        if (bbox.latitudeSpan < 1e-6 || bbox.longitudeSpanWithDateLine < 1e-6) {
            map.controller.setZoom(16.0)
            map.controller.setCenter(bbox.centerWithDateLine)
        } else {
            map.zoomToBoundingBox(bbox, false, FIT_BORDER_PX)
        }
    }
    if (sized()) { fit(); return }
    map.addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
        override fun onLayoutChange(v: View, l: Int, t: Int, r: Int, b: Int, ol: Int, ot: Int, or: Int, ob: Int) {
            if (!sized()) return
            map.removeOnLayoutChangeListener(this)
            fit()
        }
    })
}
