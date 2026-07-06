import 'package:flutter/material.dart';

/// Proje X marka renkleri — karanlık tema öncelikli (plan §1.3).
class Brand {
  static const bg = Color(0xFF0E0F13);
  static const surface = Color(0xFF171922);
  static const surfaceHigh = Color(0xFF1F2230);
  static const primary = Color(0xFF7C5CFF);
  static const secondary = Color(0xFFFF5C8A);
  static const success = Color(0xFF3DDC97);
  static const warning = Color(0xFFFFC24B);
  static const danger = Color(0xFFFF5C5C);
  static const textDim = Color(0xFF8B90A3);
}

ThemeData buildTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: ColorScheme.fromSeed(
      seedColor: Brand.primary,
      brightness: Brightness.dark,
      surface: Brand.surface,
    ).copyWith(
      primary: Brand.primary,
      secondary: Brand.secondary,
      error: Brand.danger,
    ),
    scaffoldBackgroundColor: Brand.bg,
  );

  return base.copyWith(
    appBarTheme: const AppBarTheme(
      backgroundColor: Brand.bg,
      elevation: 0,
      centerTitle: true,
      titleTextStyle: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: Colors.white),
    ),
    cardTheme: base.cardTheme.copyWith(
      color: Brand.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Brand.primary,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Colors.white,
        side: const BorderSide(color: Brand.surfaceHigh, width: 1.5),
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Brand.surface,
      hintStyle: const TextStyle(color: Brand.textDim),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: Brand.primary, width: 1.5),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: Brand.surfaceHigh,
      contentTextStyle: const TextStyle(color: Colors.white),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
    bottomNavigationBarTheme: const BottomNavigationBarThemeData(
      backgroundColor: Brand.surface,
      selectedItemColor: Brand.primary,
      unselectedItemColor: Brand.textDim,
    ),
    dividerTheme: const DividerThemeData(color: Brand.surfaceHigh, thickness: 1),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: Brand.surface,
      selectedColor: Brand.primary.withValues(alpha: 0.25),
      side: const BorderSide(color: Brand.surfaceHigh),
      labelStyle: const TextStyle(color: Colors.white),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    ),
    dialogTheme: base.dialogTheme.copyWith(
      backgroundColor: Brand.surfaceHigh,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Brand.surfaceHigh,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
    ),
  );
}

/// İsimden deterministik avatar rengi üretir.
Color avatarColor(String name) {
  const palette = [
    Color(0xFF7C5CFF), Color(0xFFFF5C8A), Color(0xFF3DDC97),
    Color(0xFFFFC24B), Color(0xFF4BB3FF), Color(0xFFFF8A5C),
  ];
  var h = 0;
  for (final c in name.codeUnits) {
    h = (h * 31 + c) & 0x7fffffff;
  }
  return palette[h % palette.length];
}
