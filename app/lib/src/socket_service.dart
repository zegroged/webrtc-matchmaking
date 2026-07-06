import 'dart:async';
import 'package:socket_io_client/socket_io_client.dart' as sio;
import 'api_client.dart';
import 'config.dart';
import 'models.dart';

/// Socket.IO bağlantısı ve gerçek zamanlı olay akışları.
/// HomeShell yaşam döngüsüne bağlıdır: girişte connect, çıkışta dispose.
class SocketService {
  static final SocketService instance = SocketService._();
  SocketService._();

  sio.Socket? _socket;
  bool get connected => _socket?.connected ?? false;

  // İç denetleyiciler — ekranlar aşağıdaki Stream getter'larını dinler.
  final _matchFoundCtrl = StreamController<MatchInfo>.broadcast();
  final _matchEndedCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _rtcSignalCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _friendNewCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _chatMessageCtrl = StreamController<ChatMessage>.broadcast();
  final _chatReadCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _friendPresenceCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _suspendedCtrl = StreamController<String>.broadcast();
  final _sessionReplacedCtrl = StreamController<void>.broadcast();
  final _connectionStateCtrl = StreamController<bool>.broadcast();

  Stream<MatchInfo> get matchFound => _matchFoundCtrl.stream;
  Stream<Map<String, dynamic>> get matchEnded => _matchEndedCtrl.stream;
  Stream<Map<String, dynamic>> get rtcSignal => _rtcSignalCtrl.stream;
  Stream<Map<String, dynamic>> get friendNew => _friendNewCtrl.stream;
  Stream<ChatMessage> get chatMessage => _chatMessageCtrl.stream;
  Stream<Map<String, dynamic>> get chatRead => _chatReadCtrl.stream;
  Stream<Map<String, dynamic>> get friendPresence => _friendPresenceCtrl.stream;
  Stream<String> get suspended => _suspendedCtrl.stream;
  Stream<void> get sessionReplaced => _sessionReplacedCtrl.stream;
  Stream<bool> get connectionState => _connectionStateCtrl.stream;

  void connect() {
    if (_socket != null) {
      disconnect();
    }
    final socket = sio.io(
      AppConfig.serverUrl,
      sio.OptionBuilder()
          .setTransports(['websocket'])
          .disableAutoConnect()
          .setAuth({'token': ApiClient.token})
          .setReconnectionDelay(1500)
          .build(),
    );
    _socket = socket;

    socket.onConnect((_) => _connectionStateCtrl.add(true));
    socket.onDisconnect((_) => _connectionStateCtrl.add(false));

    socket.on('match:found', (data) {
      try {
        _matchFoundCtrl.add(MatchInfo.fromJson(Map<String, dynamic>.from(data)));
      } catch (_) {}
    });
    socket.on('match:ended', (data) {
      _matchEndedCtrl.add(Map<String, dynamic>.from(data ?? {}));
    });
    socket.on('rtc:signal', (data) {
      _rtcSignalCtrl.add(Map<String, dynamic>.from(data ?? {}));
    });
    socket.on('friend:new', (data) {
      _friendNewCtrl.add(Map<String, dynamic>.from(data ?? {}));
    });
    socket.on('chat:message', (data) {
      try {
        _chatMessageCtrl.add(ChatMessage.fromJson(
            Map<String, dynamic>.from((data as Map)['message'])));
      } catch (_) {}
    });
    socket.on('chat:read', (data) {
      _chatReadCtrl.add(Map<String, dynamic>.from(data ?? {}));
    });
    socket.on('friend:presence', (data) {
      _friendPresenceCtrl.add(Map<String, dynamic>.from(data ?? {}));
    });
    socket.on('account:suspended', (data) {
      _suspendedCtrl.add((data is Map ? data['message'] : null) as String? ??
          'Hesabınız geçici olarak askıya alındı.');
    });
    socket.on('session:replaced', (_) => _sessionReplacedCtrl.add(null));

    socket.connect();
  }

  void disconnect() {
    _socket?.dispose();
    _socket = null;
  }

  Future<Map<String, dynamic>> _emitAck(String event, Map<String, dynamic> payload,
      {Duration timeout = const Duration(seconds: 8)}) {
    final completer = Completer<Map<String, dynamic>>();
    final s = _socket;
    if (s == null || !s.connected) {
      return Future.value({
        'ok': false,
        'error': 'offline',
        'message': 'Bağlantı yok. İnternetinizi kontrol edin.',
      });
    }
    s.emitWithAck(event, payload, ack: (res) {
      if (!completer.isCompleted) {
        completer.complete(res is Map ? Map<String, dynamic>.from(res) : {'ok': false});
      }
    });
    return completer.future.timeout(timeout,
        onTimeout: () => {'ok': false, 'error': 'timeout', 'message': 'Sunucu yanıt vermedi.'});
  }

  Future<Map<String, dynamic>> joinQueue(String mood) =>
      _emitAck('queue:join', {'mood': mood});

  Future<Map<String, dynamic>> leaveQueue() => _emitAck('queue:leave', {});

  Future<Map<String, dynamic>> skipMatch() => _emitAck('match:skip', {});

  Future<Map<String, dynamic>> endMatch() => _emitAck('match:end', {});

  Future<Map<String, dynamic>> reportMatch({
    required int matchId,
    required String category,
    String? note,
    String? snapshotBase64,
  }) =>
      _emitAck('match:report', {
        'matchId': matchId,
        'category': category,
        if (note != null && note.isNotEmpty) 'note': note,
        'snapshot': ?snapshotBase64,
      }, timeout: const Duration(seconds: 15));

  Future<Map<String, dynamic>> addFriend(int matchId) =>
      _emitAck('friend:add', {'matchId': matchId});

  Future<Map<String, dynamic>> sendChat(int friendshipId, String body) =>
      _emitAck('chat:send', {'friendshipId': friendshipId, 'body': body});

  void markRead(int friendshipId) {
    _socket?.emit('chat:read', {'friendshipId': friendshipId});
  }

  void sendSignal(int matchId, Map<String, dynamic> data) {
    _socket?.emit('rtc:signal', {'matchId': matchId, 'data': data});
  }

  Future<List<int>> queryPresence(List<int> userIds) async {
    final res = await _emitAck('presence:query', {'userIds': userIds});
    return List<int>.from(res['online'] ?? const []);
  }
}
