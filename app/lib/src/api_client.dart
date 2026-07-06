import 'dart:convert';
import 'package:http/http.dart' as http;
import 'config.dart';

class ApiException implements Exception {
  final int status;
  final String error;
  final String message;
  ApiException(this.status, this.error, this.message);
  @override
  String toString() => message;
}

/// REST istemcisi. Hata gövdelerindeki Türkçe `message` alanı kullanıcıya
/// doğrudan gösterilebilir.
class ApiClient {
  static String? token;

  static Map<String, String> _headers() => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  static Future<Map<String, dynamic>> _handle(http.Response res) async {
    Map<String, dynamic> body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      body = {};
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        res.statusCode,
        body['error'] as String? ?? 'unknown',
        body['message'] as String? ?? 'Bir şeyler ters gitti (${res.statusCode}).',
      );
    }
    return body;
  }

  static Uri _u(String path) => Uri.parse('${AppConfig.serverUrl}$path');

  static Future<Map<String, dynamic>> get(String path) async =>
      _handle(await http.get(_u(path), headers: _headers()));

  static Future<Map<String, dynamic>> post(String path, [Object? body]) async =>
      _handle(await http.post(_u(path), headers: _headers(), body: jsonEncode(body ?? {})));

  static Future<Map<String, dynamic>> put(String path, Object body) async =>
      _handle(await http.put(_u(path), headers: _headers(), body: jsonEncode(body)));

  static Future<Map<String, dynamic>> delete(String path) async =>
      _handle(await http.delete(_u(path), headers: _headers()));
}
