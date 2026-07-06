import 'package:flutter/material.dart';

/// Proje X marka renkleri — aydınlık (beyaz) tema.
/// Görüntülü görüşme ekranı video arayüzü olduğu için bilinçli olarak koyu kalır.
class Brand {
  static const bg = Color(0xFFF6F7FB);          // sayfa zemini (yumuşak beyaz)
  static const surface = Color(0xFFFFFFFF);      // kartlar, girdi alanları
  static const surfaceHigh = Color(0xFFE9EBF3);  // kenarlıklar, ikincil yüzey
  static const primary = Color(0xFF7C5CFF);
  static const secondary = Color(0xFFFF5C8A);
  static const success = Color(0xFF1FA968);      // aydınlık zeminde okunur koyulukta
  static const warning = Color(0xFFB97D0A);
  static const danger = Color(0xFFE5484D);
  static const text = Color(0xFF1A1C25);         // ana metin (koyu)
  static const textDim = Color(0xFF6B7183);      // ikincil metin

  // Video görüşme ekranı için koyu yüzeyler (aydınlık temadan bağımsız).
  static const callDark = Color(0xFF0E0F13);
  static const callSurface = Color(0xFF23252F);
}

ThemeData buildTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: ColorScheme.fromSeed(
      seedColor: Brand.primary,
      brightness: Brightness.light,
      surface: Brand.surface,
    ).copyWith(
      primary: Brand.primary,
      secondary: Brand.secondary,
      error: Brand.danger,
      onSurface: Brand.text,
    ),
    scaffoldBackgroundColor: Brand.bg,
  );

  return base.copyWith(
    appBarTheme: const AppBarTheme(
      backgroundColor: Brand.bg,
      elevation: 0,
      centerTitle: true,
      titleTextStyle: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: Brand.text),
      iconTheme: IconThemeData(color: Brand.text),
    ),
    cardTheme: base.cardTheme.copyWith(
      color: Brand.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: Brand.surfaceHigh),
      ),
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
        foregroundColor: Brand.text,
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
        borderSide: const BorderSide(color: Brand.surfaceHigh),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: Brand.surfaceHigh),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: Brand.primary, width: 1.5),
      ),
    ),
    // Aydınlık arayüzde yüzen bildirimler koyu kalır: yüksek kontrast.
    snackBarTheme: SnackBarThemeData(
      backgroundColor: Brand.callSurface,
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
      selectedColor: Brand.primary.withValues(alpha: 0.15),
      side: const BorderSide(color: Brand.surfaceHigh),
      labelStyle: const TextStyle(color: Brand.text),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    ),
    dialogTheme: base.dialogTheme.copyWith(
      backgroundColor: Brand.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Brand.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
    ),
  );
}

/// İsimden deterministik avatar rengi üretir.
Color avatarColor(String name) {
  const palette = [
    Color(0xFF7C5CFF), Color(0xFFFF5C8A), Color(0xFF1FA968),
    Color(0xFFE8A013), Color(0xFF2E90FA), Color(0xFFF97316),
  ];
  var h = 0;
  for (final c in name.codeUnits) {
    h = (h * 31 + c) & 0x7fffffff;
  }
  return palette[h % palette.length];
}
