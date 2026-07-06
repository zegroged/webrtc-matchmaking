import 'dart:async';
import 'package:flutter/material.dart';
import '../api_client.dart';
import '../models.dart';
import '../session.dart';
import '../socket_service.dart';
import '../theme.dart';
import 'chat_screen.dart';

/// Sohbetler: arkadaş listesi + son mesaj + okunmamış rozeti + çevrimiçi durumu.
class ChatsScreen extends StatefulWidget {
  final VoidCallback? onSeen;
  const ChatsScreen({super.key, this.onSeen});

  @override
  State<ChatsScreen> createState() => _ChatsScreenState();
}

class _ChatsScreenState extends State<ChatsScreen>
    with AutomaticKeepAliveClientMixin {
  List<FriendEntry> _friends = [];
  bool _loading = true;
  final _subs = <StreamSubscription>[];

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
    final sock = SocketService.instance;
    _subs.add(sock.friendNew.listen((_) => _load()));
    _subs.add(sock.chatMessage.listen(_onIncoming));
    _subs.add(sock.friendPresence.listen(_onPresence));
    _subs.add(sock.connectionState.listen((up) {
      if (up) _load();
    }));
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await ApiClient.get('/api/friends');
      final list = (res['friends'] as List)
          .map((j) => FriendEntry.fromJson(Map<String, dynamic>.from(j)))
          .toList();
      // Çevrimiçi durumlarını sorgula.
      final online = await SocketService.instance
          .queryPresence(list.map((f) => f.friend.id).toList());
      for (final f in list) {
        f.online = online.contains(f.friend.id);
      }
      if (mounted) {
        setState(() {
          _friends = list;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _onIncoming(ChatMessage msg) {
    final idx = _friends.indexWhere((f) => f.friendshipId == msg.friendshipId);
    if (idx == -1) {
      _load();
      return;
    }
    setState(() {
      final f = _friends[idx];
      f.lastMessageBody = msg.flagged ? '⚠ filtrelenen mesaj' : msg.body;
      f.lastMessageSenderId = msg.senderId;
      f.lastMessageAt = msg.createdAt;
      f.unread++;
      _friends.removeAt(idx);
      _friends.insert(0, f);
    });
  }

  void _onPresence(Map<String, dynamic> data) {
    final idx = _friends.indexWhere((f) => f.friend.id == data['userId']);
    if (idx != -1 && mounted) {
      setState(() => _friends[idx].online = data['online'] == true);
    }
  }

  Future<void> _openChat(FriendEntry entry) async {
    setState(() => entry.unread = 0);
    widget.onSeen?.call();
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ChatScreen(entry: entry),
    ));
    _load();
  }

  Future<void> _showOptions(FriendEntry entry) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.person_remove_rounded, color: Brand.warning),
              title: const Text('Arkadaşlıktan çıkar'),
              onTap: () => Navigator.of(ctx).pop('unfriend'),
            ),
            ListTile(
              leading: const Icon(Icons.block_rounded, color: Brand.danger),
              title: const Text('Engelle'),
              subtitle: const Text('Bir daha eşleşemez ve yazamaz',
                  style: TextStyle(color: Brand.textDim, fontSize: 12)),
              onTap: () => Navigator.of(ctx).pop('block'),
            ),
            ListTile(
              leading: const Icon(Icons.flag_rounded, color: Brand.danger),
              title: const Text('Bildir'),
              onTap: () => Navigator.of(ctx).pop('report'),
            ),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;

    if (action == 'unfriend') {
      final ok = await _confirm('Arkadaşlıktan çıkar',
          '${entry.friend.displayName} arkadaş listenden silinecek ve mesaj geçmişiniz kaybolacak.');
      if (ok) {
        await ApiClient.delete('/api/friends/${entry.friendshipId}');
        _load();
      }
    } else if (action == 'block') {
      final ok = await _confirm('Engelle',
          '${entry.friend.displayName} engellenecek: arkadaşlık silinir, bir daha eşleşemez ve size yazamaz.');
      if (ok) {
        await ApiClient.post('/api/blocks/${entry.friend.id}');
        _load();
      }
    } else if (action == 'report') {
      await _reportFriend(entry);
    }
  }

  Future<bool> _confirm(String title, String message) async {
    final res = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Vazgeç')),
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Onayla', style: TextStyle(color: Brand.danger))),
        ],
      ),
    );
    return res == true;
  }

  Future<void> _reportFriend(FriendEntry entry) async {
    String? selected;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setD) => AlertDialog(
          title: const Text('Bildir'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Son mesajlarınız kanıt olarak eklenir.',
                  style: TextStyle(color: Brand.textDim, fontSize: 13)),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: selected,
                hint: const Text('Sebep seçin'),
                items: const [
                  DropdownMenuItem(value: 'taciz', child: Text('Taciz / Zorbalık')),
                  DropdownMenuItem(value: 'nefret', child: Text('Nefret Söylemi')),
                  DropdownMenuItem(value: 'spam', child: Text('Spam / Dolandırıcılık')),
                  DropdownMenuItem(value: 'diger', child: Text('Diğer')),
                ],
                onChanged: (v) => setD(() => selected = v),
              ),
            ],
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('Vazgeç')),
            TextButton(
                onPressed: selected == null
                    ? null
                    : () => Navigator.of(ctx).pop(true),
                child:
                    const Text('Bildir', style: TextStyle(color: Brand.danger))),
          ],
        ),
      ),
    );
    if (ok == true && selected != null && mounted) {
      await ApiClient.post(
          '/api/friends/${entry.friendshipId}/report', {'category': selected});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Bildiriminiz alındı. Teşekkürler. 🙏')));
      }
    }
  }

  String _timeLabel(int? ms) {
    if (ms == null) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    final now = DateTime.now();
    if (d.year == now.year && d.month == now.month && d.day == now.day) {
      return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    }
    return '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Sohbetler')),
      body: RefreshIndicator(
        onRefresh: _load,
        color: Brand.primary,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _friends.isEmpty
                ? _emptyView()
                : ListView.separated(
                    physics: const AlwaysScrollableScrollPhysics(),
                    itemCount: _friends.length,
                    separatorBuilder: (_, _) =>
                        const Divider(height: 1, indent: 76),
                    itemBuilder: (ctx, i) {
                      final f = _friends[i];
                      final me = Session.instance.user?.id;
                      final prefix =
                          f.lastMessageSenderId == me ? 'Sen: ' : '';
                      return ListTile(
                        onTap: f.deleted ? null : () => _openChat(f),
                        onLongPress: () => _showOptions(f),
                        contentPadding: const EdgeInsets.symmetric(
                            horizontal: 16, vertical: 6),
                        leading: Stack(
                          children: [
                            CircleAvatar(
                              radius: 26,
                              backgroundColor:
                                  avatarColor(f.friend.displayName),
                              child: Text(
                                f.friend.displayName.isNotEmpty
                                    ? f.friend.displayName[0].toUpperCase()
                                    : '?',
                                style: const TextStyle(
                                    fontSize: 20,
                                    fontWeight: FontWeight.w800,
                                    color: Colors.white),
                              ),
                            ),
                            if (f.online)
                              Positioned(
                                right: 0,
                                bottom: 0,
                                child: Container(
                                  width: 14,
                                  height: 14,
                                  decoration: BoxDecoration(
                                    color: Brand.success,
                                    shape: BoxShape.circle,
                                    border: Border.all(
                                        color: Brand.bg, width: 2.5),
                                  ),
                                ),
                              ),
                          ],
                        ),
                        title: Text(
                          f.friend.displayName,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        subtitle: Text(
                          f.lastMessageBody != null
                              ? '$prefix${f.lastMessageBody}'
                              : 'Yeni arkadaş — merhaba de! 👋',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: f.unread > 0 ? Brand.text : Brand.textDim,
                            fontWeight:
                                f.unread > 0 ? FontWeight.w600 : FontWeight.w400,
                          ),
                        ),
                        trailing: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(_timeLabel(f.lastMessageAt),
                                style: const TextStyle(
                                    color: Brand.textDim, fontSize: 12)),
                            const SizedBox(height: 4),
                            if (f.unread > 0)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 8, vertical: 2),
                                decoration: BoxDecoration(
                                  color: Brand.primary,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Text('${f.unread}',
                                    style: const TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.w700)),
                              ),
                          ],
                        ),
                      );
                    },
                  ),
      ),
    );
  }

  Widget _emptyView() {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: const [
        SizedBox(height: 120),
        Icon(Icons.chat_bubble_outline_rounded, size: 64, color: Brand.textDim),
        SizedBox(height: 16),
        Text('Henüz arkadaşın yok',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        SizedBox(height: 8),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: 40),
          child: Text(
            'Görüşme sırasında iki taraf da "Arkadaş Ekle" derse burada kalıcı olarak sohbet edebilirsiniz.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Brand.textDim),
          ),
        ),
      ],
    );
  }
}
