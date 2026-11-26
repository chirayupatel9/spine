package dev.chirayupatel.music

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import dev.chirayupatel.music.net.Api

class App : Application(), SingletonImageLoader.Factory {
    lateinit var api: Api
        private set

    override fun onCreate() {
        super.onCreate()
        api = Api(this)
    }

    // Covers sit behind sign-in, so images load through the same client (and cookie) as the API.
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { api.client })) }
            .crossfade(220)
            .build()
}
