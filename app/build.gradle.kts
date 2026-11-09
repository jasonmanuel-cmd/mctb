plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.mctb.autoreply"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mctb.autoreply"

        // 29 = Android 10. A third-party CallScreeningService is only bound by the
        // framework from API 29; below that only the default dialer's is used.
        // RoleManager is also API 29+. Raising the floor removes a branch that
        // would otherwise never work.
        minSdk = 29
        targetSdk = 35
        versionCode = 2
        versionName = "2.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    /**
     * Release signing, driven entirely by Gradle properties so no secret ever
     * lives in the repository or in CI config.
     *
     * Conditional on purpose: when the properties are absent (CI, a fresh clone)
     * the release variant still builds unsigned. That keeps `assembleRelease`
     * usable as a compile check instead of failing for want of a keystore.
     *
     * Supply these in ~/.gradle/gradle.properties or as CI secrets:
     *   MCTB_KEYSTORE=/absolute/path/to/release.jks
     *   MCTB_STORE_PASSWORD=...
     *   MCTB_KEY_ALIAS=...
     *   MCTB_KEY_PASSWORD=...
     */
    val keystorePath = providers.gradleProperty("MCTB_KEYSTORE").orNull
    if (keystorePath != null) {
        signingConfigs {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = providers.gradleProperty("MCTB_STORE_PASSWORD").orNull
                keyAlias = providers.gradleProperty("MCTB_KEY_ALIAS").orNull
                keyPassword = providers.gradleProperty("MCTB_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (keystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests {
            // Fail loudly on a framework call that reaches into android.jar stubs
            // rather than silently returning a default and passing a broken test.
            isReturnDefaultValues = false
        }
    }
}

dependencies {
    // Core Android
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")

    // Compose BOM
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.8.5")

    // Lifecycle - also supplies lifecycle.compose.LocalLifecycleOwner, which
    // replaces the deprecated androidx.compose.ui.platform version.
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    // DataStore
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Play Billing. 8.x: queryProductDetailsAsync returns a QueryProductDetailsResult.
    implementation("com.android.billingclient:billing:8.0.0")

    // Testing
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")

    // Debug
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
