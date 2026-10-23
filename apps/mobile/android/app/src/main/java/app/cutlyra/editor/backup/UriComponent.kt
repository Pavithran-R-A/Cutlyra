package app.cutlyra.editor.backup

/**
 * A Kotlin reimplementation of JavaScript's `encodeURIComponent`, used to
 * build archive-internal entry paths that are byte-for-byte identical to the
 * ones the TypeScript reference implementation produces
 * (`packages/editor-core/src/services/backup/archive-format.ts`). The two
 * platforms must agree on every entry name so an archive written by one can
 * be read by the other; the IDs being encoded are UUIDs (hex + dashes), so
 * encoding is normally a no-op, but matching the exact escaping keeps the
 * format honest for any future non-UUID id.
 */
object UriComponent {
	// Everything encodeURIComponent leaves unescaped, minus nothing — the
	// exact set is: A-Z a-z 0-9 - _ . ! ~ * ' ( )
	private fun isUnreserved(c: Char): Boolean =
		(c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') ||
			c == '-' || c == '_' || c == '.' || c == '!' ||
			c == '~' || c == '*' || c == '\'' || c == '(' || c == ')'

	fun encode(value: String): String {
		val sb = StringBuilder()
		for (byte in value.toByteArray(Charsets.UTF_8)) {
			val b = byte.toInt() and 0xFF
			val c = b.toChar()
			if (isUnreserved(c)) {
				sb.append(c)
			} else {
				sb.append('%')
				sb.append(String.format("%02X", b))
			}
		}
		return sb.toString()
	}
}
