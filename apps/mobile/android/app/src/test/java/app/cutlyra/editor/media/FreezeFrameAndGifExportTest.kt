package app.cutlyra.editor.media

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FreezeFrameAndGifExportTest {

    @Test
    fun `freeze config round trips through json`() {
        val c = FreezeFrameConfig.create("el1", 1_000_000L, 500_000L, "el2")
        val round = FreezeFrameConfig.fromJson(c.toJson())
        assertEquals(c, round)
    }

    @Test
    fun `freeze ops are idempotent on apply`() {
        val c = FreezeFrameConfig.create("el1", 1_000_000L, 500_000L, "el2")
        val once = FreezeFrameOps.apply(emptyList(), c)
        val twice = FreezeFrameOps.apply(once, c)
        assertEquals(1, twice.size)
    }

    @Test
    fun `freeze ops undo removes by id`() {
        val c = FreezeFrameConfig.create("el1", 1_000_000L, 500_000L, "el2")
        val list = FreezeFrameOps.apply(emptyList(), c)
        val undone = FreezeFrameOps.undo(list, c.id)
        assertTrue(undone.isEmpty())
    }

    @Test
    fun `freeze ops serialize deserialize round trips`() {
        val c = FreezeFrameConfig.create("el1", 1_000_000L, 500_000L, "el2")
        val list = listOf(c)
        val raw = FreezeFrameOps.serialize(list)
        val back = FreezeFrameOps.deserialize(raw)
        assertEquals(list, back)
    }

    @Test
    fun `freeze ops deserialize skips malformed entries`() {
        val raw = """[{"id":"x","sourceElementId":"e","sourceFrameTimestampMicros":1,"holdDurationMicros":2,"targetElementId":"t"},{"broken":true}]"""
        val back = FreezeFrameOps.deserialize(raw)
        assertEquals(1, back.size)
    }

    @Test
    fun `gif export plan normalizes zero delays`() {
        val plan = GifExportPlan.fromDelays("a", 4, 4, 0, listOf(0L, 100_000L))
        val n = plan.normalized()
        assertEquals(10_000L, n.frames[0].delayMicros)
        assertEquals(100_000L, n.frames[1].delayMicros)
    }

    @Test
    fun `gif export plan loop duration sums frames`() {
        val plan = GifExportPlan.fromDelays("a", 4, 4, 0, listOf(100_000L, 200_000L))
        assertEquals(300_000L, plan.loopDurationMicros)
    }

    @Test
    fun `gif export plan invalid when empty`() {
        val plan = GifExportPlan.fromDelays("a", 4, 4, 0, emptyList())
        assertTrue(!plan.isValid)
    }
}