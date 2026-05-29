// Dart parser test — exercises class / mixin / extension / enum / typedef /
// top-level function / method / getter / setter / constructor and import
// normalization (package:, dart:, bare same-dir, ../ relative).

import { describe, it, expect } from "vitest";

import { parseDart } from "../src/scanner/parsers/dart.js";

const FIXTURE = `
import 'package:flutter/material.dart';
import '../widgets/vault_lock.dart' show VaultLockScreen;
import 'dart:async' as async;
import 'sibling.dart';

class VaultProvider extends StateNotifier<VaultState> {
  VaultProvider() : super(VaultState.locked);

  Future<void> unlock(String pin) async {
    return;
  }

  String get displayName => state.name;
  set displayName(String value) => _name = value;
}

mixin LoggingMixin {
  void log(String msg) {
    print(msg);
  }
}

extension StringExt on String {
  String get capitalized => "x";
}

enum VaultState { locked, unlocked, error }

typedef VaultCallback = void Function(String);

void main() {
  print("hi");
}

String topLevelFn(int x) => "$x";
`;

describe("dart parser", () => {
  it("extracts symbols + normalized imports from a Flutter-flavored sample", async () => {
    const result = await parseDart(
      { absPath: "/x/foo.dart", relPath: "foo.dart", ext: ".dart", size: FIXTURE.length },
      FIXTURE,
    );

    const byName = (n: string) => result.symbols.find((s) => s.name === n);

    expect(byName("VaultProvider")).toMatchObject({ kind: "class" });
    expect(byName("LoggingMixin")).toMatchObject({ kind: "class" });
    expect(byName("StringExt")).toMatchObject({ kind: "class" });
    expect(byName("VaultState")).toMatchObject({ kind: "enum" });
    expect(byName("VaultCallback")).toMatchObject({ kind: "type" });
    expect(byName("main")).toMatchObject({ kind: "function" });
    expect(byName("topLevelFn")).toMatchObject({ kind: "function" });
    expect(byName("unlock")).toMatchObject({ kind: "method" });
    expect(byName("displayName")).toMatchObject({ kind: "method" });
    expect(byName("log")).toMatchObject({ kind: "method" });
    expect(byName("capitalized")).toMatchObject({ kind: "method" });

    // package:foo and dart:foo are stripped (cross-project boundary).
    expect(result.imports).not.toContain("package:flutter/material.dart");
    expect(result.imports).not.toContain("dart:async");

    // ../widgets/foo.dart stays as-is. Bare sibling.dart is normalized to ./sibling.dart.
    expect(result.imports).toContain("../widgets/vault_lock.dart");
    expect(result.imports).toContain("./sibling.dart");
  });
});
