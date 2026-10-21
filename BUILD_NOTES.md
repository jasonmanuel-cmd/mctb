# Build Notes

## Environment

| | |
|---|---|
| JDK | 17 |
| Gradle | 8.9 (wrapper) |
| Android Gradle Plugin | 8.7.0 |
| Kotlin | 2.0.21 |
| compileSdk / targetSdk | 35 |
| minSdk | **29** (Android 10) |

`minSdk` is 29, not 26. A third-party `CallScreeningService` is only bound by the
framework from API 29 (below that, only the default dialer's is used), and
`RoleManager` is API 29+. Supporting older devices would mean shipping a code path
that can never work.

## One-time bootstrap: the Gradle wrapper jar

`gradle/wrapper/gradle-wrapper.jar` is **not committed**, so `./gradlew` cannot run
from a fresh clone. Either:

1. Open the project in Android Studio and set *Settings → Build, Execution,
   Deployment → Build Tools → Gradle → Use Gradle from: `gradle-wrapper.properties`
   file*. This drives Gradle directly and does not need the jar.
2. Or generate it once and commit it:

```bash
gradle wrapper --gradle-version 8.9
git add gradle/wrapper/gradle-wrapper.jar
git commit -m "Commit Gradle wrapper jar"
```

Option 2 is strongly preferred for a project with CI. `.gitignore` does not exclude
it.

## Building

```bash
./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
./gradlew test              # JVM unit tests for domain/ (no device needed)
./gradlew lint              # Android lint
./gradlew assembleRelease   # UNSIGNED - see below
```

## Static gate

```bash
python3 tools/check_project.py
```

Run this before every commit. It is **not** a compiler — it is a consistency gate that
catches the classes of defect that broke the previous revision of this project:
unresolved `R.*` and `@type/name` resource references, manifest components pointing at
classes that do not exist, permissions used in code but not declared, `stringResource`
format-arg mismatches, and the `dataStore.data.collect {}` deadlock.

It was mutation-tested: injecting a missing string resource, the DataStore deadlock, a
phantom manifest component and a format-arg mismatch produces exactly four findings.

## Release signing — not yet configured

`assembleRelease` currently produces an **unsigned** artifact. Before uploading to
Play, add a signing config and keep the keystore out of version control:

```kotlin
// app/build.gradle.kts
android {
    signingConfigs {
        create("release") {
            storeFile = file(providers.gradleProperty("MCTB_KEYSTORE").get())
            storePassword = providers.gradleProperty("MCTB_STORE_PASSWORD").get()
            keyAlias = providers.gradleProperty("MCTB_KEY_ALIAS").get()
            keyPassword = providers.gradleProperty("MCTB_KEY_PASSWORD").get()
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true   // see below
            isShrinkResources = true
        }
    }
}
```

Supply the four properties via `~/.gradle/gradle.properties` or CI secrets — never
commit them.

If you enable `isMinifyEnabled`, the existing `app/proguard-rules.pro` needs review:
it currently contains a blanket `-keep class androidx.compose.** { *; }`, which
defeats most of the benefit of shrinking. Compose and Play Billing both ship consumer
rules, so the blanket keep is likely unnecessary.

## Before shipping

See the **Play Console launch checklist** in `README.md`. The two items most easily
forgotten:

1. The in-app product `unlimited_replies` must exist in Play Console **and** the build
   must be on a release track, or billing will report the product as unfetched.
2. The store listing must describe the app as preparing a reply you send in one tap.
   Describing it as fully automatic would misrepresent it.

## What has not been verified

No build, compile or device run has been performed on this revision — there is no JDK,
Gradle or Android SDK in the environment it was written in, and
`services.gradle.org`, `dl.google.com` and `maven.google.com` are unreachable from
there. Expect to fix small compilation errors on the first Gradle sync, and test the
screening-service → receiver → notification path on real hardware (especially Samsung
and Xiaomi) before submitting.
