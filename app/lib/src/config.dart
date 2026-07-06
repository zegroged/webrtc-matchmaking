import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Sunucu adresi çözümü:
///  - Web: uygulama backend tarafından servis edildiği için aynı origin kullanılır.
///  - Android emülatör: 10.0.2.2 host makineyi gösterir (varsayılan).
///  - Gerçek cihaz: giriş ekranındaki "Sunucu adresi" alanından LAN IP girilir,
///    tercih olarak saklanır.
class AppConfig {
  static const _key = 'server_url';
  static String _serverUrl = kIsWeb
      ? Uri.base.origin
      : 'http://10.0.2.2:3000';

  static String get serverUrl => _serverUrl;

  static Future<void> load() async {
    if (kIsWeb) return; // web'de her zaman aynı origin
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_key);
    if (saved != null && saved.isNotEmpty) _serverUrl = saved;
  }

  static Future<void> setServerUrl(String url) async {
    var u = url.trim();
    if (u.isEmpty) return;
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'http://$u';
    if (u.endsWith('/')) u = u.substring(0, u.length - 1);
    _serverUrl = u;
    if (!kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, u);
    }
  }
}

/// Uygulama genelinde kullanılan sabit sözlükler (backend ile uyumlu).
class Catalog {
  static const moods = <String, ({String label, String emoji, String desc})>{
    'derin': (label: 'Derin Sohbet', emoji: '🌙', desc: 'Gerçek konular, gerçek insanlar'),
    'hafif': (label: 'Hafif Muhabbet', emoji: '☕', desc: 'Rahat, akışına bırak'),
    'dil': (label: 'Dil Pratiği', emoji: '🌍', desc: 'Yeni bir dilde konuş'),
    'eglence': (label: 'Eğlence', emoji: '🎉', desc: 'Gül, eğlen, geç'),
  };

  static const interests = <String, ({String label, String emoji})>{
    'muzik': (label: 'Müzik', emoji: '🎵'),
    'oyun': (label: 'Oyun', emoji: '🎮'),
    'spor': (label: 'Spor', emoji: '⚽'),
    'sinema': (label: 'Sinema & Dizi', emoji: '🎬'),
    'kitap': (label: 'Kitap', emoji: '📚'),
    'teknoloji': (label: 'Teknoloji', emoji: '💻'),
    'seyahat': (label: 'Seyahat', emoji: '✈️'),
    'yemek': (label: 'Yemek', emoji: '🍜'),
    'sanat': (label: 'Sanat', emoji: '🎨'),
    'bilim': (label: 'Bilim', emoji: '🔬'),
  };

  static const languages = <String, String>{
    'tr': 'Türkçe',
    'en': 'İngilizce',
    'de': 'Almanca',
    'fr': 'Fransızca',
    'es': 'İspanyolca',
    'ar': 'Arapça',
    'ru': 'Rusça',
  };

  static const reportCategories = <String, String>{
    'ciplaklik': 'Çıplaklık / Müstehcenlik',
    'taciz': 'Taciz / Zorbalık',
    'nefret': 'Nefret Söylemi',
    'siddet': 'Şiddet / Tehdit',
    'resit_olmayan': 'Reşit Olmayan Şüphesi',
    'spam': 'Spam / Dolandırıcılık',
    'diger': 'Diğer',
  };
}
