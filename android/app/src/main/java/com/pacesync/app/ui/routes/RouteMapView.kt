package com.pacesync.app.ui.routes

import android.graphics.Color as AndroidColor
import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.pacesync.app.network.dto.RoutePoint
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.OnlineTileSourceBase
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.MapTileIndex
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polyline
import kotlinx.coroutines.delay
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.BitmapDrawable

private const val RUN_DURATION_MS = 15_000L
private const val RUN_FRAME_MS = 33L

// Arrow pointing up (north); rotated per frame to the direction of travel.
private fun arrowBitmap(sizePx: Int): Bitmap {
    val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    val s = sizePx.toFloat()
    val path = Path().apply {
        moveTo(s / 2, s * 0.06f)
        lineTo(s * 0.88f, s * 0.9f)
        lineTo(s / 2, s * 0.7f)
        lineTo(s * 0.12f, s * 0.9f)
        close()
    }
    c.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = AndroidColor.WHITE; style = Paint.Style.FILL })
    c.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = AndroidColor.parseColor("#111827"); style = Paint.Style.STROKE; strokeWidth = s * 0.07f; strokeJoin = Paint.Join.ROUND })
    return bmp
}

private const val FIT_BORDER_PX = 64

// Esri World Imagery — the same satellite tiles the web route map uses
// (URL order is z/y/x, not osmdroid's default z/x/y).
private val ESRI_SATELLITE = object : OnlineTileSourceBase(
    "EsriWorldImagery", 0, 19, 256, "",
    arrayOf("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/"),
) {
    override fun getTileURLString(pMapTileIndex: Long): String =
        baseUrl + MapTileIndex.getZoom(pMapTileIndex) + "/" + MapTileIndex.getY(pMapTileIndex) + "/" + MapTileIndex.getX(pMapTileIndex)
}

// Shared polyline-on-OSM renderer, factored out of RouteMapScreen so the
// activity-detail screen (ui/detail/ActivityDetailScreen.kt) can embed the
// same map without duplicating the osmdroid setup/Polyline/bounding-box
// logic. Pass an empty list to get the "No GPS data" message.
@Composable
fun RouteMapView(
    points: List<RoutePoint>,
    modifier: Modifier = Modifier.fillMaxSize(),
    satellite: Boolean = false,
    /** Bump to run an arrow along the route from start to finish. */
    runNonce: Int = 0,
) {
    val context = LocalContext.current
    var mapRef by remember { mutableStateOf<MapView?>(null) }
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
            }.also { mapRef = it }
        },
        update = { mapView ->
            val source = if (satellite) ESRI_SATELLITE else TileSourceFactory.MAPNIK
            if (mapView.tileProvider.tileSource.name() != source.name()) {
                mapView.setTileSource(source)
                mapView.invalidate()
            }
            // update runs on every recomposition — only rebuild/re-fit when
            // the route itself changes.
            if (mapView.tag === points) return@AndroidView
            mapView.tag = points
            val geoPoints = points.map { GeoPoint(it.lat, it.lng) }
            mapView.overlays.clear()
            // Bright red with a dark edge underneath, so the route stands out on
            // both the street map and satellite imagery.
            mapView.overlays.add(
                Polyline().apply {
                    setPoints(geoPoints)
                    outlinePaint.color = AndroidColor.parseColor("#B3000000")
                    outlinePaint.strokeWidth = 14f
                },
            )
            mapView.overlays.add(
                Polyline().apply {
                    setPoints(geoPoints)
                    outlinePaint.color = AndroidColor.parseColor("#FF1F1F")
                    outlinePaint.strokeWidth = 9f
                },
            )
            fitWhenLaidOut(mapView, BoundingBox.fromGeoPointsSafe(geoPoints))
            mapView.invalidate()
        },
        onRelease = { it.onDetach() },
    )

    // "Run ▶▶": an arrow travels the route at a constant speed (by distance,
    // not GPS sample count), pointing the way it's heading.
    LaunchedEffect(runNonce, points) {
        val map = mapRef ?: return@LaunchedEffect
        if (runNonce == 0 || points.size < 2) return@LaunchedEffect
        val geo = points.map { GeoPoint(it.lat, it.lng) }
        val cum = DoubleArray(geo.size)
        for (i in 1 until geo.size) cum[i] = cum[i - 1] + geo[i - 1].distanceToAsDouble(geo[i])
        val total = cum.last()
        if (total <= 0.0) return@LaunchedEffect
        val density = context.resources.displayMetrics.density
        val base = arrowBitmap((30 * density).toInt())
        val rotated = HashMap<Int, BitmapDrawable>()
        fun iconFor(bearing: Double): BitmapDrawable {
            val deg = ((Math.round(bearing / 5.0) * 5).toInt() % 360 + 360) % 360
            return rotated.getOrPut(deg) {
                val m = android.graphics.Matrix().apply { postRotate(deg.toFloat()) }
                BitmapDrawable(context.resources, Bitmap.createBitmap(base, 0, 0, base.width, base.height, m, true))
            }
        }
        map.overlays.removeAll { it is Marker && it.id == "run-arrow" }
        val marker = Marker(map).apply {
            id = "run-arrow"
            setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
            setInfoWindow(null)
            position = geo.first()
        }
        map.overlays.add(marker)
        try {
            val start = System.currentTimeMillis()
            var seg = 1
            while (true) {
                val t = ((System.currentTimeMillis() - start).toDouble() / RUN_DURATION_MS).coerceAtMost(1.0)
                val d = t * total
                while (seg < geo.size - 1 && cum[seg] < d) seg++
                val a0 = geo[seg - 1]; val a1 = geo[seg]
                val span = cum[seg] - cum[seg - 1]
                val f = if (span > 0) ((d - cum[seg - 1]) / span).coerceIn(0.0, 1.0) else 0.0
                marker.position = GeoPoint(a0.latitude + (a1.latitude - a0.latitude) * f, a0.longitude + (a1.longitude - a0.longitude) * f)
                if (span > 0) marker.icon = iconFor(a0.bearingTo(a1))
                map.invalidate()
                if (t >= 1.0) break
                delay(RUN_FRAME_MS)
            }
            delay(1500) // pause at the finish
        } finally {
            map.overlays.remove(marker)
            map.invalidate()
        }
    }
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
