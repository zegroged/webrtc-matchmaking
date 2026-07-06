import 'dart:async';
import 'package:flutter/material.dart';
import '../api_client.dart';
import '../config.dart';
import '../models.dart';
import '../session.dart';
import '../socket_service.dart';
import '../theme.dart';
import '../widgets/user_avatar.dart';
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
  List<FriendRequest> _requests = [];
  bool _loading = true;
  final _subs = <StreamSubscription>[];
  final Set<int> _actingRequests = {}; // uçuştaki istek işlemleri (çift tık koruması)
  int _loadSeq = 0; // yükleme yarışı: bayat yanıtları at

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
    final sock = SocketService.instance;
    _subs.add(sock.friendNew.listen((_) => _load()));
    _subs.add(sock.friendRequest.listen((_) => _loadRequests()));
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
    await Future.wait([_loadFriends(), _loadRequests()]);
  }

  Future<void> _loadFriends() async {
    final seq = ++_loadSeq;
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
      // Bu yükleme sürerken canlı bir mesaj/olay listeyi güncellediyse
      // (_loadSeq arttıysa) bayat anlık görüntüyü yazma; taze veri gelecek.
      if (mounted && seq == _loadSeq) {
        setState(() {
          _friends = list;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadRequests() async {
    try {
      final res = await ApiClient.get('/api/friend-requests');
      final list = (res['requests'] as List)
          .map((j) => FriendRequest.fromJson(Map<String, dynamic>.from(j)))
          .toList();
      if (mounted) setState(() => _requests = list);
    } catch (_) {}
  }

  Future<void> _acceptRequest(FriendRequest r) async {
    if (!_actingRequests.add(r.matchId)) return; // çift tık koruması
    setState(() => _requests.removeWhere((x) => x.matchId == r.matchId));
    try {
      await ApiClient.post('/api/friend-requests/${r.matchId}/accept');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('🎉 ${r.from.displayName} ile artık arkadaşsınız!'),
        backgroundColor: Brand.success.withValues(alpha: 0.95),
      ));
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: Brand.danger));
        _loadRequests();
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('İstek onaylanamadı. Bağlantınızı kontrol edin.'),
            backgroundColor: Brand.danger));
        _loadRequests();
      }
    } finally {
      _actingRequests.remove(r.matchId);
    }
  }

  Future<void> _declineRequest(FriendRequest r) async {
    if (!_actingRequests.add(r.matchId)) return;
    setState(() => _requests.removeWhere((x) => x.matchId == r.matchId));
    try {
      await ApiClient.post('/api/friend-requests/${r.matchId}/decline');
    } catch (_) {
    } finally {
      _actingRequests.remove(r.matchId);
    }
  }

  void _onIncoming(ChatMessage msg) {
    _loadSeq++; // uçuştaki _loadFriends'in bu güncellemeyi ezmesini engelle
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
            : (_friends.isEmpty && _requests.isEmpty)
                ? _emptyView()
                : ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    children: [
                      if (_requests.isNotEmpty) ..._requestsSection(),
                      for (var i = 0; i < _friends.length; i++) ...[
                        if (i > 0) const Divider(height: 1, indent: 76),
                        _friendTile(_friends[i]),
                      ],
                    ],
                  ),
      ),
    );
  }

  /// İstek kutusu: yanlışlıkla geçilen eşleşmelerden gelen tek taraflı
  /// istekler buradan onaylanabilir.
  List<Widget> _requestsSection() {
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Row(
          children: [
            const Text('Arkadaşlık İstekleri',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: Brand.secondary,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text('${_requests.length}',
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: Colors.white)),
            ),
          ],
        ),
      ),
      ..._requests.map((r) => Card(
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  UserAvatar(
                      name: r.from.displayName,
                      avatarUrl: r.from.avatarUrl,
                      radius: 24),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${r.from.displayName}, ${r.from.age}',
                            style:
                                const TextStyle(fontWeight: FontWeight.w700)),
                        Text(
                          r.from.interests
                              .map((i) => Catalog.interests[i]?.label ?? i)
                              .join(', '),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              color: Brand.textDim, fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    tooltip: 'Onayla',
                    onPressed: () => _acceptRequest(r),
                    style: IconButton.styleFrom(
                        backgroundColor: Brand.success,
                        foregroundColor: Colors.white),
                    icon: const Icon(Icons.check_rounded),
                  ),
                  IconButton(
                    tooltip: 'Reddet',
                    onPressed: () => _declineRequest(r),
                    style: IconButton.styleFrom(
                        backgroundColor: Brand.surfaceHigh,
                        foregroundColor: Brand.textDim),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
          )),
      if (_friends.isNotEmpty)
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 14, 16, 4),
          child: Text('Sohbetler',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
        ),
    ];
  }

  Widget _friendTile(FriendEntry f) {
    final me = Session.instance.user?.id;
    final prefix = f.lastMessageSenderId == me ? 'Sen: ' : '';
    return ListTile(
      onTap: f.deleted ? null : () => _openChat(f),
      onLongPress: () => _showOptions(f),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      leading: Stack(
        children: [
          UserAvatar(
              name: f.friend.displayName,
              avatarUrl: f.friend.avatarUrl,
              radius: 26),
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
                  border: Border.all(color: Brand.bg, width: 2.5),
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
          fontWeight: f.unread > 0 ? FontWeight.w600 : FontWeight.w400,
        ),
      ),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(_timeLabel(f.lastMessageAt),
              style: const TextStyle(color: Brand.textDim, fontSize: 12)),
          const SizedBox(height: 4),
          if (f.unread > 0)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: Brand.primary,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text('${f.unread}',
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: Colors.white)),
            ),
        ],
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
