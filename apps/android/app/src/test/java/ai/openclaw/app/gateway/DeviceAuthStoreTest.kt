package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceAuthStoreTest {
  @Before
  fun resetState() {
    File(RuntimeEnvironment.getApplication().filesDir, "openclaw").deleteRecursively()
  }

  @Test
  fun saveTokenPersistsNormalizedScopesMetadataInSQLite() {
    val app = RuntimeEnvironment.getApplication()
    val store = DeviceAuthStore(app, legacyPrefsOverride = legacyPrefs(app))

    store.saveToken(
      deviceId = " Device-1 ",
      role = " Operator ",
      token = " operator-token ",
      scopes = listOf("operator.write", "operator.read", "operator.write", " "),
    )

    val entry = store.loadEntry("device-1", "operator")
    assertNotNull(entry)
    assertEquals("operator-token", entry?.token)
    assertEquals("operator", entry?.role)
    assertEquals(listOf("operator.read", "operator.write"), entry?.scopes)
    assertTrue((entry?.updatedAtMs ?: 0L) > 0L)
    val row = OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator")
    assertNotNull(row)
    assertEquals("operator-token", row?.token)
    assertEquals("""["operator.read","operator.write"]""", row?.scopesJson)
  }

  @Test
  fun clearTokenUpdatesSQLiteStore() {
    val app = RuntimeEnvironment.getApplication()
    val store = DeviceAuthStore(app, legacyPrefsOverride = legacyPrefs(app))
    store.saveToken("device-1", "operator", "operator-token", scopes = listOf("operator.read"))

    store.clearToken("device-1", "operator")

    assertNull(store.loadEntry("device-1", "operator"))
    assertNull(OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator"))
  }

  @Test
  fun loadEntryMigratesLegacySecurePrefsToken() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    prefs.putString("gateway.deviceToken.device-1.operator", " operator-token ")
    prefs.putString(
      "gateway.deviceTokenMeta.device-1.operator",
      """{"scopes":["operator.write"," operator.read ","operator.write"],"updatedAtMs":1700000000000}""",
    )

    val entry = DeviceAuthStore(app, legacyPrefsOverride = prefs).loadEntry(" Device-1 ", " Operator ")

    assertNotNull(entry)
    assertEquals("operator-token", entry?.token)
    assertEquals("operator", entry?.role)
    assertEquals(listOf("operator.read", "operator.write"), entry?.scopes)
    assertEquals(1700000000000L, entry?.updatedAtMs)
    assertNull(prefs.getString("gateway.deviceToken.device-1.operator"))
    assertNull(prefs.getString("gateway.deviceTokenMeta.device-1.operator"))
    assertEquals(
      "operator-token",
      OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator")?.token,
    )
  }

  private fun legacyPrefs(context: Context): SecurePrefs {
    val prefs = context.getSharedPreferences("openclaw.node.secure.test", Context.MODE_PRIVATE)
    prefs.edit().clear().commit()
    return SecurePrefs(context, securePrefsOverride = prefs)
  }
}
