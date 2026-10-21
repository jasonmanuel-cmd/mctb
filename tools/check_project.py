#!/usr/bin/env python3
"""
Static consistency gate for the mctb Android project.

This is NOT a compiler. There is no JDK, Gradle or Android SDK in this
environment and the hosts they need (services.gradle.org, dl.google.com,
maven.google.com) are unreachable, so `./gradlew assembleDebug` cannot be run.

What it does instead is check, mechanically and over the real source files, the
classes of defect that made the previous revision of this project non-functional:
missing string resources, manifest entries pointing at classes that do not
exist, permissions used in code but not declared, and the DataStore
`data.collect {}` pattern that never returns.

Exit code 0 = all checks passed, 1 = findings.
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN = ROOT / "app" / "src" / "main"
JAVA = MAIN / "java"
RES = MAIN / "res"
MANIFEST = MAIN / "AndroidManifest.xml"
PACKAGE_PREFIX = "com.mctb.autoreply"

ANDROID_NS = "{http://schemas.android.com/apk/res/android}"

findings: list[str] = []
warnings: list[str] = []

# (path, permission name) pairs used in Kotlin source
perms_used: list = []


def fail(msg: str) -> None:
    findings.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


# --------------------------------------------------------------------------
# Resource inventory
# --------------------------------------------------------------------------

def collect_defined_resources() -> dict[str, set[str]]:
    defined: dict[str, set[str]] = {
        "string": set(), "color": set(), "style": set(), "dimen": set(),
        "bool": set(), "integer": set(), "plurals": set(), "array": set(),
        "string-array": set(), "id": set(),
    }
    file_based = {"drawable": set(), "mipmap": set(), "xml": set(), "layout": set(), "anim": set()}

    for values_file in sorted(RES.glob("values*/*.xml")):
        try:
            root = ET.parse(values_file).getroot()
        except ET.ParseError as exc:
            fail(f"{values_file.relative_to(ROOT)}: XML parse error: {exc}")
            continue
        for child in root:
            tag = child.tag
            name = child.get("name")
            if tag == "style" and name:
                defined["style"].add(name)
            elif tag in defined and name:
                defined[tag].add(name)

    for kind in file_based:
        for res_dir in sorted(RES.glob(f"{kind}*")):
            if not res_dir.is_dir():
                continue
            for entry in res_dir.iterdir():
                if entry.is_file() and entry.suffix == ".xml":
                    file_based[kind].add(entry.stem)
        defined[kind] = file_based[kind]

    return defined


# --------------------------------------------------------------------------
# Kotlin source scan
# --------------------------------------------------------------------------

def strip_kotlin_noise(src: str) -> str:
    """Remove comments and string/template literals so brace counting is honest."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
        elif c == '"':
            if src[i:i + 3] == '"""':
                i += 3
                while i + 2 < n and src[i:i + 3] != '"""':
                    i += 1
                i += 3
            else:
                i += 1
                while i < n and src[i] != '"':
                    if src[i] == "\\":
                        i += 1
                    i += 1
                i += 1
            out.append('""')
        elif c == "'":
            i += 1
            while i < n and src[i] != "'":
                if src[i] == "\\":
                    i += 1
                i += 1
            i += 1
            out.append("''")
        else:
            out.append(c)
            i += 1
    return "".join(out)


DECL_RE = re.compile(
    r"^\s*(?:@\w+(?:\([^)]*\))?\s+)*"
    r"(?:public|private|internal|protected|abstract|final|open|sealed|data|enum|value|annotation|\s)*"
    r"\b(class|object|interface|fun|val|var|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE,
)

PACKAGE_RE = re.compile(r"^\s*package\s+([\w.]+)", re.MULTILINE)
IMPORT_RE = re.compile(r"^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?", re.MULTILINE)
R_REF_RE = re.compile(r"\bR\.(string|drawable|color|mipmap|xml|style|id|plurals|array|dimen|integer)\.([A-Za-z0-9_]+)")
PERM_REF_RE = re.compile(r"Manifest\.permission\.([A-Z0-9_]+)")
BALANCE_PAIRS = {")": "(", "]": "[", "}": "{"}


def scan_kotlin(defined: dict[str, set[str]]):
    kt_files = sorted(JAVA.rglob("*.kt"))
    if not kt_files:
        fail("no Kotlin sources found under app/src/main/java")
        return {}, []

    declarations: dict[str, set[str]] = {}
    all_imports: list[tuple[Path, str]] = []
    all_src: list[tuple[Path, str]] = []

    for path in kt_files:
        rel = path.relative_to(ROOT)
        raw = path.read_text(encoding="utf-8")
        all_src.append((path, raw))

        pkg_match = PACKAGE_RE.search(raw)
        if not pkg_match:
            fail(f"{rel}: no package declaration")
            continue
        pkg = pkg_match.group(1)

        expected_pkg = str(path.parent.relative_to(JAVA).as_posix()).replace("/", ".")
        if pkg != expected_pkg:
            fail(f"{rel}: package '{pkg}' does not match directory (expected '{expected_pkg}')")

        # Accumulate: several files share one package, and assigning would drop
        # every declaration but the last file's.
        declarations.setdefault(pkg, set()).update(
            m.group(2) for m in DECL_RE.finditer(raw)
        )

        for imp in IMPORT_RE.findall(raw):
            all_imports.append((path, imp))

        # -- resource references --
        for kind, name in R_REF_RE.findall(raw):
            if kind == "drawable" and raw.count(f"android.R.drawable.{name}"):
                continue  # framework drawable, not ours
            if name not in defined.get(kind, set()):
                fail(f"{rel}: R.{kind}.{name} is not defined in res/")

        # -- permissions referenced in code --
        for perm in PERM_REF_RE.findall(raw):
            yield ("perm", path, perm)

        # -- DataStore deadlock pattern --
        if re.search(r"dataStore\.data[\s\S]{0,200}?\.collect\s*\{", raw):
            fail(
                f"{rel}: `dataStore.data....collect {{}}` never returns - DataStore.data is "
                f"an infinite flow. Use `.first()` for a one-shot read."
            )

        # -- bracket balance --
        clean = strip_kotlin_noise(raw)
        stack: list[tuple[str, int]] = []
        line = 1
        balanced = True
        for ch in clean:
            if ch == "\n":
                line += 1
            elif ch in "([{":
                stack.append((ch, line))
            elif ch in ")]}":
                if not stack or stack[-1][0] != BALANCE_PAIRS[ch]:
                    fail(f"{rel}: unbalanced '{ch}' at line {line}")
                    balanced = False
                    break
                stack.pop()
        if balanced and stack:
            fail(f"{rel}: {len(stack)} unclosed bracket(s), first opened at line {stack[0][1]}")

    yield ("decls", declarations, all_imports)
    yield ("src", all_src, None)


def check_format_args(all_src):
    """`stringResource(R.string.x, a, b)` must match the string's placeholders."""
    strings: dict[str, str] = {}
    for values_file in RES.glob("values/strings.xml"):
        for child in ET.parse(values_file).getroot():
            if child.tag == "string" and child.get("name"):
                strings[child.get("name")] = "".join(child.itertext())

    call_re = re.compile(r"(?:stringResource|getString)\s*\(")
    for path, raw in all_src:
        for m in call_re.finditer(raw):
            start = m.end()
            depth, i = 1, start
            while i < len(raw) and depth:
                if raw[i] in "([{":
                    depth += 1
                elif raw[i] in ")]}":
                    depth -= 1
                i += 1
            args_src = raw[start:i - 1]

            # Split top-level commas.
            args, depth, cur = [], 0, ""
            for ch in args_src:
                if ch in "([{":
                    depth += 1
                elif ch in ")]}":
                    depth -= 1
                if ch == "," and depth == 0:
                    args.append(cur.strip())
                    cur = ""
                else:
                    cur += ch
            if cur.strip():
                args.append(cur.strip())
            if not args:
                continue

            ref = re.match(r"R\.string\.([A-Za-z0-9_]+)", args[0])
            if not ref:
                continue
            name = ref.group(1)
            template = strings.get(name)
            if template is None:
                continue  # already reported as a missing resource

            positional = set(re.findall(r"%(\d+)\$", template))
            simple = len(re.findall(r"(?<!%\d\$)%[-#+ 0,(]*[sdfoxX]", template))
            expected = len(positional) if positional else simple
            supplied = len(args) - 1

            if expected != supplied:
                line_no = raw[:m.start()].count("\n") + 1
                fail(
                    f"{path.relative_to(ROOT)}:{line_no}: R.string.{name} expects "
                    f"{expected} format arg(s) but {supplied} supplied"
                )


def check_manifest_components():
    try:
        root = ET.parse(MANIFEST).getroot()
    except ET.ParseError as exc:
        fail(f"AndroidManifest.xml: XML parse error: {exc}")
        return set()

    declared_perms = {
        el.get(f"{ANDROID_NS}name")
        for el in root.findall("uses-permission")
    }

    app = root.find("application")
    if app is None:
        fail("AndroidManifest.xml: no <application> element")
        return declared_perms

    for tag in ("activity", "service", "receiver", "provider"):
        for el in app.findall(tag):
            name = el.get(f"{ANDROID_NS}name")
            if not name:
                fail(f"AndroidManifest.xml: <{tag}> without android:name")
                continue
            fqn = name if name.startswith(PACKAGE_PREFIX) else f"{PACKAGE_PREFIX}{name}"
            rel_path = JAVA / Path(fqn.replace(".", "/") + ".kt")
            if not rel_path.exists():
                fail(
                    f"AndroidManifest.xml: <{tag}> android:name='{name}' resolves to "
                    f"{fqn} but {rel_path.relative_to(ROOT)} does not exist"
                )
            else:
                simple = fqn.rsplit(".", 1)[-1]
                if not re.search(
                    rf"\b(class|object)\s+{re.escape(simple)}\b",
                    rel_path.read_text(encoding="utf-8"),
                ):
                    fail(
                        f"AndroidManifest.xml: {rel_path.relative_to(ROOT)} does not declare "
                        f"a class named '{simple}'"
                    )

    # exported / permission sanity for the screening service
    for svc in app.findall("service"):
        intent_actions = [
            i.get(f"{ANDROID_NS}name")
            for f in svc.findall("intent-filter")
            for i in f.findall("action")
        ]
        if "android.telecom.CallScreeningService" in intent_actions:
            if svc.get(f"{ANDROID_NS}permission") != "android.permission.BIND_SCREENING_SERVICE":
                fail(
                    "AndroidManifest.xml: CallScreeningService must be guarded by "
                    "android.permission.BIND_SCREENING_SERVICE"
                )
            if svc.get(f"{ANDROID_NS}exported") != "true":
                fail("AndroidManifest.xml: CallScreeningService must be exported=true")

    return declared_perms


XML_RES_REF_RE = re.compile(r"@(\+?)([a-z]+)/([A-Za-z0-9_.]+)")


def check_xml_resource_references(defined: dict[str, set[str]]):
    """Validate `@type/name` references inside the manifest and every res XML file.

    Resource resolution is configuration-independent, so a `values-night` file
    may legitimately point at a colour declared in `values/`.
    """
    targets = [MANIFEST] + sorted(f for f in RES.rglob("*.xml"))
    for path in targets:
        text = path.read_text(encoding="utf-8")
        # Strip comments so documentation cannot produce phantom references.
        text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
        for is_new, kind, name in XML_RES_REF_RE.findall(text):
            if is_new or kind == "android":
                continue
            if kind.startswith("style"):
                continue
            if kind not in defined:
                continue  # unknown namespace (e.g. @dimen from a library) - not ours to judge
            if name not in defined[kind]:
                fail(
                    f"{path.relative_to(ROOT)}: @{kind}/{name} is not defined in res/"
                )


def check_imports(declarations: dict[str, set[str]], all_imports):
    for path, imp in all_imports:
        if not imp.startswith(PACKAGE_PREFIX):
            continue
        if imp.endswith(".*"):
            continue
        pkg, _, symbol = imp.rpartition(".")
        known = declarations.get(pkg)
        if known is None:
            # Package with no source files - could be a nested/companion ref.
            continue
        if symbol not in known:
            fail(f"{path.relative_to(ROOT)}: import {imp} - no '{symbol}' declared in package {pkg}")


def check_store_listing():
    """Play enforces hard length limits on listing copy.

    A short description over 80 characters is rejected at upload time, which is a
    slow and annoying way to find out, so assert it here instead.
    """
    listing = ROOT / "docs" / "PLAY_LISTING.md"
    if not listing.exists():
        warn("docs/PLAY_LISTING.md missing - no store listing pack")
        return

    text = listing.read_text(encoding="utf-8")

    def block_after(heading: str) -> str | None:
        m = re.search(
            rf"^##\s*{re.escape(heading)}.*?```\n(.*?)```",
            text,
            re.MULTILINE | re.DOTALL,
        )
        return m.group(1).strip() if m else None

    short = block_after("2. Short description")
    if short is None:
        fail("docs/PLAY_LISTING.md: could not locate the short description block")
    elif len(short) > 80:
        fail(
            f"docs/PLAY_LISTING.md: short description is {len(short)} chars; "
            f"Google Play allows 80"
        )

    name = block_after("1. App name")
    if name is None:
        fail("docs/PLAY_LISTING.md: could not locate the app name block")
    elif len(name) > 30:
        fail(
            f"docs/PLAY_LISTING.md: app name is {len(name)} chars; Google Play allows 30"
        )


def main() -> int:
    defined = collect_defined_resources()

    declared_perms: set[str] = set()
    all_src: list = []

    declarations: dict[str, set[str]] = {}
    all_imports: list = []

    for kind, a, b in scan_kotlin(defined):
        if kind == "perm":
            perms_used.append((a, b))
        elif kind == "decls":
            declarations, all_imports = a, b
        elif kind == "src":
            all_src = a

    declared_perms = check_manifest_components()

    for path, perm in perms_used:
        full = f"android.permission.{perm}"
        if full not in declared_perms:
            fail(
                f"{path.relative_to(ROOT)}: uses Manifest.permission.{perm} but "
                f"{full} is not declared in AndroidManifest.xml"
            )

    check_imports(declarations, all_imports)
    check_format_args(all_src)
    check_xml_resource_references(defined)
    check_store_listing()
    check_removed_references(all_src)

    if warnings:
        print("WARNINGS")
        for w in warnings:
            print(f"  ! {w}")
        print()

    if findings:
        print(f"FAILED - {len(findings)} finding(s)\n")
        for f in findings:
            print(f"  x {f}")
        return 1

    print("OK - all static checks passed")
    print(f"    {len(list(JAVA.rglob('*.kt')))} Kotlin files, "
          f"{len(defined['string'])} string resources, "
          f"{len(declared_perms)} manifest permissions")
    return 0


LEGACY_SYMBOLS = [
    "CallMonitorService", "BootReceiver", "CallReceiver", "SmsHandler",
    "SEND_SMS", "READ_CALL_LOG", "FOREGROUND_SERVICE_PHONE_CALL",
    "RECEIVE_BOOT_COMPLETED", "startForeground", "accompanist",
]


def check_removed_references(all_src):
    """Nothing may still point at the pre-rebuild architecture.

    Comments are stripped first: several files legitimately *document* why
    SEND_SMS / READ_CALL_LOG / a foreground service are absent, and that
    documentation is desirable, not a violation.
    """
    for path, raw in all_src:
        raw = strip_kotlin_noise(raw)
        for symbol in LEGACY_SYMBOLS:
            if re.search(rf"\b{re.escape(symbol)}\b", raw):
                fail(
                    f"{path.relative_to(ROOT)}: still references removed symbol '{symbol}'"
                )

    manifest = MANIFEST.read_text(encoding="utf-8")
    for symbol in ("SEND_SMS", "READ_CALL_LOG", "FOREGROUND_SERVICE", "RECEIVE_BOOT_COMPLETED"):
        if re.search(rf'uses-permission[^>]*{symbol}', manifest):
            fail(f"AndroidManifest.xml: still declares a restricted/removed permission: {symbol}")


if __name__ == "__main__":
    sys.exit(main())
