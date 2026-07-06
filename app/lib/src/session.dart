import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_client.dart';
import 'models.dart';

/// Oturum durumu: JWT + kullanıcı profili. Token shared_preferences'ta saklanır.
class Session extends ChangeNotifier {
  static final Session instance = Session._();
  Session._();

  User? user;
  bool get isLoggedIn => user != null;

  static const _tokenKey = 'auth_token';

  /// Uygulama açılışında: kayıtlı token varsa doğrula ve profili çek.
  Future<bool> restore() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_tokenKey);
    if (token == null) return false;
    ApiClient.token = token;
    try {
      final res = await ApiClient.get('/api/me');
      user = User.fromJson(Map<String, dynamic>.from(res['user']));
      notifyListeners();
      return true;
    } on ApiException catch (e) {
      if (e.status == 401 || e.status == 403) {
        await logout();
      }
      return false;
    } catch (_) {
      // Ağ hatası: token'ı silme, çevrimdışı başlangıç kabul et.
      return false;
    }
  }

  Future<void> login(String token, User u) async {
    ApiClient.token = token;
    user = u;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
    notifyListeners();
  }

  Future<void> refreshProfile() async {
    final res = await ApiClient.get('/api/me');
    user = User.fromJson(Map<String, dynamic>.from(res['user']));
    notifyListeners();
  }

  Future<void> logout() async {
    ApiClient.token = null;
    user = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    notifyListeners();
  }

  Future<void> deleteAccount() async {
    await ApiClient.delete('/api/me');
    await logout();
  }
}
