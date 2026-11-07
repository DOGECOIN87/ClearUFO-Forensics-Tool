package com.clearufo.forensics.engine.kernels

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.Par
import com.clearufo.forensics.engine.colorInt
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

// Vector drawing on frames: annotations are rendered with android.graphics into a transparent bitmap and
// composited onto the float data, so pixels outside the annotations keep their full precision (as in the
// browser workbench, which uses an OffscreenCanvas the same way).

class Draw(val canvas: Canvas) {
    val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1f }
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

    fun strokeColor(hex: String, alpha: Double = 1.0) { stroke.color = colorInt(hex, alpha) }
    fun fillColor(hex: String, alpha: Double = 1.0) { fill.color = colorInt(hex, alpha) }
    fun lineWidth(w: Double) { stroke.strokeWidth = w.toFloat() }
    fun dash(on: Float, off: Float) { stroke.pathEffect = DashPathEffect(floatArrayOf(on, off), 0f) }
    fun noDash() { stroke.pathEffect = null }

    fun line(x1: Double, y1: Double, x2: Double, y2: Double) = canvas.drawLine(x1.toFloat(), y1.toFloat(), x2.toFloat(), y2.toFloat(), stroke)
    fun rect(x: Double, y: Double, w: Double, h: Double, doFill: Boolean, doStroke: Boolean) {
        val r = RectF(x.toFloat(), y.toFloat(), (x + w).toFloat(), (y + h).toFloat()).apply { sort() }
        if (doFill) canvas.drawRect(r, fill)
        if (doStroke) canvas.drawRect(r, stroke)
    }
    fun ellipse(cx: Double, cy: Double, rx: Double, ry: Double, doFill: Boolean, doStroke: Boolean) {
        val r = RectF((cx - rx).toFloat(), (cy - ry).toFloat(), (cx + rx).toFloat(), (cy + ry).toFloat())
        if (doFill) canvas.drawOval(r, fill)
        if (doStroke) canvas.drawOval(r, stroke)
    }
    fun circle(cx: Double, cy: Double, r: Double, doFill: Boolean) = canvas.drawCircle(cx.toFloat(), cy.toFloat(), r.toFloat(), if (doFill) fill else stroke)
    fun poly(pts: List<Pair<Double, Double>>, closed: Boolean) {
        if (pts.size < 2) return
        val p = Path()
        p.moveTo(pts[0].first.toFloat(), pts[0].second.toFloat())
        for (i in 1 until pts.size) p.lineTo(pts[i].first.toFloat(), pts[i].second.toFloat())
        if (closed) p.close()
        canvas.drawPath(p, stroke)
    }

    fun arrowHead(x1: Double, y1: Double, x2: Double, y2: Double, size: Double) {
        val a = atan2(y2 - y1, x2 - x1)
        val p = Path()
        p.moveTo(x2.toFloat(), y2.toFloat())
        p.lineTo((x2 - size * cos(a - Math.PI / 7)).toFloat(), (y2 - size * sin(a - Math.PI / 7)).toFloat())
        p.lineTo((x2 - size * cos(a + Math.PI / 7)).toFloat(), (y2 - size * sin(a + Math.PI / 7)).toFloat())
        p.close()
        canvas.drawPath(p, fill)
    }

    fun font(family: String, size: Double, bold: Boolean) {
        val base = when (family) { "serif" -> Typeface.SERIF; "mono" -> Typeface.MONOSPACE; else -> Typeface.SANS_SERIF }
        text.typeface = Typeface.create(base, if (bold) Typeface.BOLD else Typeface.NORMAL)
        text.textSize = size.toFloat()
    }

    fun measure(s: String): Double = text.measureText(s).toDouble()

    /** Text label (top-left anchored, multi-line) with an optional translucent background box. */
    fun label(s: String, x: Double, y: Double, size: Double, color: Int, bg: Int?, family: String = "sans", bold: Boolean = true) {
        font(family, size, bold)
        val lines = s.split("\n")
        val lh = size * 1.2
        val wMax = lines.maxOf { measure(it) }
        if (bg != null) {
            val p = Paint().apply { this.color = bg; style = Paint.Style.FILL }
            canvas.drawRect((x - size * 0.25).toFloat(), (y - size * 0.15).toFloat(), (x - size * 0.25 + wMax + size * 0.5).toFloat(), (y - size * 0.15 + lh * lines.size + size * 0.1).toFloat(), p)
        }
        text.color = color
        val fm = text.fontMetrics
        lines.forEachIndexed { i, l -> canvas.drawText(l, x.toFloat(), (y + i * lh - fm.ascent).toFloat(), text) }
    }
}

/** Draws on a transparent layer the size of the frame and composites it onto a copy of the float data. */
fun overlay(f: Frame, draw: (Draw) -> Unit): Frame {
    val bmp = Bitmap.createBitmap(max(1, f.w), max(1, f.h), Bitmap.Config.ARGB_8888)
    bmp.eraseColor(0)
    draw(Draw(Canvas(bmp)))
    val px = IntArray(f.w * f.h)
    bmp.getPixels(px, 0, f.w, 0, 0, f.w, f.h) // unpremultiplied ARGB
    bmp.recycle()
    val out = f.d.copyOf()
    Par.forRows(f.h) { y0, y1 ->
        for (i in y0 * f.w until y1 * f.w) {
            val c = px[i]
            val a = c ushr 24
            if (a == 0) continue
            val t = a / 255.0
            val k = i * 4
            out[k] = (out[k] + (((c shr 16) and 255) - out[k]) * t).toFloat()
            out[k + 1] = (out[k + 1] + (((c shr 8) and 255) - out[k + 1]) * t).toFloat()
            out[k + 2] = (out[k + 2] + ((c and 255) - out[k + 2]) * t).toFloat()
        }
    }
    return Frame(f.w, f.h, out)
}
