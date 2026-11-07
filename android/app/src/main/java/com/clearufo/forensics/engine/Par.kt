package com.clearufo.forensics.engine

import java.util.concurrent.ExecutionException
import java.util.concurrent.ForkJoinPool
import java.util.concurrent.ForkJoinTask
import kotlin.math.max
import kotlin.math.min

/**
 * Multi-core scheduling for the kernels. Every kernel computes each output row (or channel) with the same
 * expression whatever the banding, so the results are identical with 1 or N threads; only the speed changes.
 * The Galaxy Z Fold3 (Snapdragon 888) has 8 cores: 1 Cortex-X1, 3 A78 and 4 A55.
 */
object Par {
    private val cores = max(1, Runtime.getRuntime().availableProcessors())

    @Volatile var threads: Int = cores
        set(v) { field = v.coerceIn(1, 16) }

    val available: Int get() = cores

    private val pool: ForkJoinPool by lazy {
        ForkJoinPool(max(2, cores), { p ->
            ForkJoinPool.defaultForkJoinWorkerThreadFactory.newThread(p).apply { name = "clearufo-kernel-$poolIndex"; priority = Thread.NORM_PRIORITY }
        }, null, false)
    }

    /** Runs body(y0, y1) over row bands of [0, n). */
    fun forRows(n: Int, grain: Int = 4, body: (Int, Int) -> Unit) {
        val t = threads
        if (t <= 1 || n < 2 * grain) { body(0, n); return }
        val parts = min(t * 3, (n + grain - 1) / grain)
        val tasks = (0 until parts).map { k ->
            val a = (n.toLong() * k / parts).toInt(); val b = (n.toLong() * (k + 1) / parts).toInt()
            ForkJoinTask.adapt { if (b > a) body(a, b) }
        }
        run(tasks)
    }

    /** Runs body(i) for i in [0, n) in parallel (channels, frames, independent jobs). */
    fun forEach(n: Int, body: (Int) -> Unit) {
        if (threads <= 1 || n <= 1) { for (i in 0 until n) body(i); return }
        run((0 until n).map { i -> ForkJoinTask.adapt { body(i) } })
    }

    private fun run(tasks: List<ForkJoinTask<*>>) {
        try {
            if (ForkJoinTask.inForkJoinPool()) ForkJoinTask.invokeAll(tasks)
            else pool.submit { ForkJoinTask.invokeAll(tasks) }.get()
        } catch (e: ExecutionException) {
            throw e.cause ?: e
        } catch (e: RuntimeException) {
            throw (e.cause as? RuntimeException) ?: e
        }
    }

    private var poolIndex = 0
        get() = field++
}
