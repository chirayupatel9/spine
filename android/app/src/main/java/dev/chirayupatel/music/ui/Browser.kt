package dev.chirayupatel.music.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast

/**
 * Open a sign-in page in the browser. Browsers that support Custom Tabs (Chrome and most others)
 * show it over the app in its colours; the extras below ask for that without the Custom Tabs library.
 */
fun openInBrowser(context: Context, uri: Uri) {
    val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        putExtras(Bundle().apply { putBinder("android.support.customtabs.extra.SESSION", null) })
        putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", 0xFF0C0A08.toInt())
        putExtra("androidx.browser.customtabs.extra.SHARE_STATE", 2)   // no share button
        if (context !is Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    try {
        context.startActivity(intent)
    } catch (e: ActivityNotFoundException) {
        Toast.makeText(context, "Install a web browser to sign in", Toast.LENGTH_LONG).show()
    }
}

/**
 * Where the browser hands a sign-in back (dev.chirayupatel.music://auth?...). It brings the app's
 * own screen back to the front, closing the browser tab above it, and passes the answer on.
 */
class AuthRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(
            Intent(this, MainActivity::class.java).setData(intent?.data)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }
}
