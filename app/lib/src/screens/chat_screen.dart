import 'dart:async';
import 'package:flutter/material.dart';
import '../api_client.dart';
import '../models.dart';
import '../session.dart';
import '../socket_service.dart';
import '../theme.dart';

/// Birebir kalıcı sohbet ekranı.
class ChatScreen extends StatefulWidget {
  final FriendEntry entry;
  const ChatScreen({super.key, required this.entry});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final List<ChatMessage> _messages = [];
  final _inputCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  final _subs = <StreamSubscription>[];
  bool _loading = true;
  bool _loadingMore = false;
  bool _hasMore = true;
  bool _sending = false;
  bool _peerOnline = false;

  int get _myId => Session.instance.user?.id ?? 0;

  @override
  void initState() {
    super.initState();
    _peerOnline = widget.entry.online;
    _loadHistory();
    final sock = SocketService.instance;
    _subs.add(sock.chatMessage.listen((msg) {
      if (msg.friendshipId != widget.entry.friendshipId || !mounted) return;
      setState(() => _messages.add(msg));
      sock.markRead(widget.entry.friendshipId);
      _scrollToEnd();
    }));
    _subs.add(sock.chatRead.listen((data) {
      if (data['friendshipId'] != widget.entry.friendshipId || !mounted) return;
      setState(() {
        final now = DateTime.now().millisecondsSinceEpoch;
        for (final m in _messages) {
          if (m.senderId == _myId) m.readAt ??= now;
        }
      });
    }));
    _subs.add(sock.friendPresence.listen((data) {
      if (data['userId'] == widget.entry.friend.id && mounted) {
        setState(() => _peerOnline = data['online'] == true);
      }
    }));
    // Bağlantı koptuğunda karşı taraf mesaj gönderirse yalnızca DB'ye yazılır.
    // Yeniden bağlanınca son mesajdan sonrasını çekip birleştir.
    _subs.add(sock.connectionState.listen((up) {
      if (up && mounted && !_loading) _syncNewMessages();
    }));
    _scrollCtrl.addListener(() {
      if (_scrollCtrl.position.pixels <= 40 && !_loadingMore && _hasMore) {
        _loadMore();
      }
    });
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    try {
      final res = await ApiClient.get(
          '/api/friends/${widget.entry.friendshipId}/messages?limit=50');
      final list = (res['messages'] as List)
          .map((j) => ChatMessage.fromJson(Map<String, dynamic>.from(j)))
          .toList();
      if (mounted) {
        setState(() {
          _messages.addAll(list);
          _loading = false;
          _hasMore = list.length == 50;
        });
        SocketService.instance.markRead(widget.entry.friendshipId);
        _scrollToEnd(animated: false);
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  // Yeniden bağlanma sonrası: bilinen en son mesaj id'sinden sonrasını çek,
  // id bazlı tekilleştirerek ekle (kopukluk sırasında kaçan mesajları getirir).
  Future<void> _syncNewMessages() async {
    if (_messages.isEmpty) {
      _loadHistory();
      return;
    }
    try {
      final lastId = _messages.last.id;
      final res = await ApiClient.get(
          '/api/friends/${widget.entry.friendshipId}/messages?limit=100');
      final list = (res['messages'] as List)
          .map((j) => ChatMessage.fromJson(Map<String, dynamic>.from(j)))
          .where((m) => m.id > lastId)
          .toList();
      if (list.isNotEmpty && mounted) {
        final known = _messages.map((m) => m.id).toSet();
        setState(() => _messages.addAll(list.where((m) => !known.contains(m.id))));
        SocketService.instance.markRead(widget.entry.friendshipId);
        _scrollToEnd();
      }
    } catch (_) {}
  }

  Future<void> _loadMore() async {
    if (_messages.isEmpty) return;
    setState(() => _loadingMore = true);
    try {
      final res = await ApiClient.get(
          '/api/friends/${widget.entry.friendshipId}/messages?limit=50&before=${_messages.first.id}');
      final list = (res['messages'] as List)
          .map((j) => ChatMessage.fromJson(Map<String, dynamic>.from(j)))
          .toList();
      if (mounted) {
        setState(() {
          _messages.insertAll(0, list);
          _hasMore = list.length == 50;
        });
      }
    } catch (_) {
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _scrollToEnd({bool animated = true}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollCtrl.hasClients) return;
      final target = _scrollCtrl.position.maxScrollExtent;
      if (animated) {
        _scrollCtrl.animateTo(target,
            duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      } else {
        _scrollCtrl.jumpTo(target);
      }
    });
  }

  Future<void> _send() async {
    final text = _inputCtrl.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    final res = await SocketService.instance
        .sendChat(widget.entry.friendshipId, text);
    if (!mounted) return;
    setState(() => _sending = false);
    if (res['ok'] == true) {
      _inputCtrl.clear();
      final msg =
          ChatMessage.fromJson(Map<String, dynamic>.from(res['message']));
      setState(() => _messages.add(msg));
      _scrollToEnd();
      if (msg.flagged) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              '⚠ Mesajınız topluluk kurallarına aykırı içerik nedeniyle işaretlendi.'),
          backgroundColor: Brand.warning,
        ));
      }
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text((res['message'] as String?) ?? 'Mesaj gönderilemedi.'),
        backgroundColor: Brand.danger,
      ));
    }
  }

  String _fmtTime(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  bool _isNewDay(int i) {
    if (i == 0) return true;
    final a = DateTime.fromMillisecondsSinceEpoch(_messages[i - 1].createdAt);
    final b = DateTime.fromMillisecondsSinceEpoch(_messages[i].createdAt);
    return a.year != b.year || a.month != b.month || a.day != b.day;
  }

  String _dayLabel(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    final now = DateTime.now();
    if (d.year == now.year && d.month == now.month && d.day == now.day) {
      return 'Bugün';
    }
    final yesterday = now.subtract(const Duration(days: 1));
    if (d.year == yesterday.year &&
        d.month == yesterday.month &&
        d.day == yesterday.day) {
      return 'Dün';
    }
    return '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year}';
  }

  @override
  Widget build(BuildContext context) {
    final friend = widget.entry.friend;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(
          children: [
            CircleAvatar(
              radius: 18,
              backgroundColor: avatarColor(friend.displayName),
              child: Text(
                friend.displayName.isNotEmpty
                    ? friend.displayName[0].toUpperCase()
                    : '?',
                style: const TextStyle(
                    fontSize: 15, fontWeight: FontWeight.w800, color: Colors.white),
              ),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(friend.displayName, style: const TextStyle(fontSize: 16)),
                Text(
                  _peerOnline ? 'çevrimiçi' : 'çevrimdışı',
                  style: TextStyle(
                    fontSize: 12,
                    color: _peerOnline ? Brand.success : Brand.textDim,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          if (_loadingMore)
            const Padding(
              padding: EdgeInsets.all(8),
              child: SizedBox(
                  width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2)),
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : ListView.builder(
                    controller: _scrollCtrl,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 12),
                    itemCount: _messages.length,
                    itemBuilder: (ctx, i) {
                      final m = _messages[i];
                      final mine = m.senderId == _myId;
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (_isNewDay(i))
                            Center(
                              child: Container(
                                margin:
                                    const EdgeInsets.symmetric(vertical: 10),
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 12, vertical: 4),
                                decoration: BoxDecoration(
                                  color: Brand.surface,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Text(_dayLabel(m.createdAt),
                                    style: const TextStyle(
                                        color: Brand.textDim, fontSize: 12)),
                              ),
                            ),
                          Align(
                            alignment: mine
                                ? Alignment.centerRight
                                : Alignment.centerLeft,
                            child: Container(
                              constraints: BoxConstraints(
                                  maxWidth:
                                      MediaQuery.of(context).size.width * 0.75),
                              margin: const EdgeInsets.only(bottom: 6),
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 14, vertical: 10),
                              decoration: BoxDecoration(
                                color: mine ? Brand.primary : Brand.surface,
                                borderRadius: BorderRadius.only(
                                  topLeft: const Radius.circular(16),
                                  topRight: const Radius.circular(16),
                                  bottomLeft: Radius.circular(mine ? 16 : 4),
                                  bottomRight: Radius.circular(mine ? 4 : 16),
                                ),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(m.body,
                                      style: const TextStyle(fontSize: 15)),
                                  const SizedBox(height: 2),
                                  Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      if (m.flagged)
                                        const Padding(
                                          padding: EdgeInsets.only(right: 4),
                                          child: Icon(Icons.warning_amber_rounded,
                                              size: 13, color: Brand.warning),
                                        ),
                                      Text(_fmtTime(m.createdAt),
                                          style: TextStyle(
                                              fontSize: 11,
                                              color: mine
                                                  ? Colors.white70
                                                  : Brand.textDim)),
                                      if (mine) ...[
                                        const SizedBox(width: 4),
                                        Icon(
                                          m.readAt != null
                                              ? Icons.done_all_rounded
                                              : Icons.done_rounded,
                                          size: 14,
                                          color: m.readAt != null
                                              ? Colors.lightBlueAccent
                                              : Colors.white70,
                                        ),
                                      ],
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      );
                    },
                  ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _inputCtrl,
                      minLines: 1,
                      maxLines: 4,
                      maxLength: 2000,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _send(),
                      decoration: const InputDecoration(
                        hintText: 'Mesaj yaz...',
                        counterText: '',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Material(
                    color: Brand.primary,
                    shape: const CircleBorder(),
                    child: InkWell(
                      customBorder: const CircleBorder(),
                      onTap: _sending ? null : _send,
                      child: const Padding(
                        padding: EdgeInsets.all(12),
                        child: Icon(Icons.send_rounded,
                            color: Colors.white, size: 22),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
