package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class DeviceAuthEntry(
  val token: String,
  val role: String,
  val scopes: List<String>,
  val updatedAtMs: Long,
)

@Serializable
private data class PersistedDeviceAuthMetadata(
  val scopes: List<String> = emptyList(),
  val updatedAtMs: Long = 0L,
)

interface DeviceAuthTokenStore {
  fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry?

  fun loadToken(
    deviceId: String,
    role: String,
  ): String? = loadEntry(deviceId, role)?.token

  fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String> = emptyList(),
  )

  fun clearToken(
    deviceId: String,
    role: String,
  )
}

class DeviceAuthStore(
  private val context: Context,
  private val legacyPrefsOverride: SecurePrefs? = null,
) : DeviceAuthTokenStore {
  private val json = Json { ignoreUnknownKeys = true }
  private val legacyPrefs by lazy { legacyPrefsOverride ?: SecurePrefs(context) }
  private val stateStore = OpenClawSQLiteStateStore(context)

  override fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val normalizedRole = normalizeRole(role)
    val row =
      stateStore.readDeviceAuthToken(normalizedDevice, normalizedRole)
        ?: return migrateLegacyEntry(normalizedDevice, normalizedRole)
    val token = row.token.trim().takeIf { it.isNotEmpty() } ?: return null
    return DeviceAuthEntry(
      token = token,
      role = normalizedRole,
      scopes = decodeScopes(row.scopesJson),
      updatedAtMs = row.updatedAtMs,
    )
  }

  override fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val normalizedRole = normalizeRole(role)
    val normalizedScopes = normalizeScopes(scopes)
    val latestDeviceId = stateStore.readLatestDeviceAuthDeviceId()
    if (latestDeviceId != null && latestDeviceId != normalizedDevice) {
      stateStore.deleteAllDeviceAuthTokens()
    }
    stateStore.upsertDeviceAuthToken(
      OpenClawSQLiteDeviceAuthTokenRow(
        deviceId = normalizedDevice,
        role = normalizedRole,
        token = token.trim(),
        scopesJson = json.encodeToString(normalizedScopes),
        updatedAtMs = System.currentTimeMillis(),
      ),
    )
    removeLegacyEntry(normalizedDevice, normalizedRole)
  }

  override fun clearToken(
    deviceId: String,
    role: String,
  ) {
    stateStore.deleteDeviceAuthToken(
      deviceId = normalizeDeviceId(deviceId),
      role = normalizeRole(role),
    )
    removeLegacyEntry(normalizeDeviceId(deviceId), normalizeRole(role))
  }

  private fun migrateLegacyEntry(
    normalizedDevice: String,
    normalizedRole: String,
  ): DeviceAuthEntry? {
    val token =
      legacyPrefs
        .getString(tokenKey(normalizedDevice, normalizedRole))
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: return null
    val metadata =
      legacyPrefs
        .getString(metadataKey(normalizedDevice, normalizedRole))
        ?.let { raw -> runCatching { json.decodeFromString<PersistedDeviceAuthMetadata>(raw) }.getOrNull() }
    val entry =
      DeviceAuthEntry(
        token = token,
        role = normalizedRole,
        scopes = normalizeScopes(metadata?.scopes ?: emptyList()),
        updatedAtMs = metadata?.updatedAtMs?.takeIf { it > 0L } ?: System.currentTimeMillis(),
      )
    stateStore.upsertDeviceAuthToken(
      OpenClawSQLiteDeviceAuthTokenRow(
        deviceId = normalizedDevice,
        role = normalizedRole,
        token = entry.token,
        scopesJson = json.encodeToString(entry.scopes),
        updatedAtMs = entry.updatedAtMs,
      ),
    )
    removeLegacyEntry(normalizedDevice, normalizedRole)
    return entry
  }

  private fun removeLegacyEntry(
    normalizedDevice: String,
    normalizedRole: String,
  ) {
    legacyPrefs.remove(tokenKey(normalizedDevice, normalizedRole))
    legacyPrefs.remove(metadataKey(normalizedDevice, normalizedRole))
  }

  private fun tokenKey(
    normalizedDevice: String,
    normalizedRole: String,
  ): String = "gateway.deviceToken.$normalizedDevice.$normalizedRole"

  private fun metadataKey(
    normalizedDevice: String,
    normalizedRole: String,
  ): String = "gateway.deviceTokenMeta.$normalizedDevice.$normalizedRole"

  private fun decodeScopes(raw: String): List<String> =
    runCatching { json.decodeFromString<List<String>>(raw) }
      .getOrDefault(emptyList())
      .let(::normalizeScopes)

  private fun normalizeDeviceId(deviceId: String): String = deviceId.trim().lowercase()

  private fun normalizeRole(role: String): String = role.trim().lowercase()

  private fun normalizeScopes(scopes: List<String>): List<String> =
    scopes
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .distinct()
      .sorted()
}
