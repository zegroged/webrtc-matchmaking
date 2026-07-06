import 'dart:async';
import 'package:flutter/material.dart';
import '../session.dart';
import '../socket_service.dart';
import '../theme.dart';
import 'chats_screen.dart';
import 'discover_screen.dart';
import 'onboarding_screen.dart';
import 'profile_screen.dart';

/// Ana kabuk: alt gezinme (Keşfet / Sohbetler / Profil) + socket yaşam döngüsü
/// + global olay dinleyicileri (yeni arkadaş, askıya alma, oturum değişimi).
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;
  int _unreadTotal = 0;
  final _subs = <StreamSubscription>[];

  @override
  void initState() {
    super.initState();
    final sock = SocketService.instance;
    sock.connect();

    _subs.add(sock.friendNew.listen((data) {
      if (!mounted) return;
      final friend = data['friend'] as Map?;
      final name = friend?['displayName'] ?? 'Biri';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('🎉 $name ile artık arkadaşsınız!'),
        backgroundColor: Brand.success.withValues(alpha: 0.9),
      ));
    }));

    _subs.add(sock.chatMessage.listen((_) {
      if (_tab != 1 && mounted) setState(() => _unreadTotal++);
    }));

    _subs.add(sock.suspended.listen((msg) async {
      if (!mounted) return;
      await showDialog(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: const Text('Hesap askıya alındı'),
          content: Text(msg),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Tamam'),
            ),
          ],
        ),
      );
      if (mounted) _logoutToOnboarding();
    }));

    _subs.add(sock.sessionReplaced.listen((_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Hesabınıza başka bir cihazdan giriş yapıldı.'),
      ));
    }));

    // Sunucu bağlantı el sıkışmasını reddederse (askı/ban/silinen hesap/geçersiz
    // oturum) kullanıcıya doğru nedeni göster; yeniden bağlanmayı sürdürme.
    _subs.add(sock.authError.listen((msg) async {
      if (!mounted) return;
      String title, body;
      if (msg.contains('suspended')) {
        title = 'Hesap askıya alındı';
        body = 'Hesabınız geçici olarak askıya alınmış. Bir süre sonra tekrar deneyin.';
      } else if (msg.contains('banned')) {
        title = 'Hesap engellendi';
        body = 'Hesabınız topluluk kurallarının ihlali nedeniyle kalıcı olarak kapatıldı.';
      } else if (msg.contains('account_deleted')) {
        title = 'Hesap silindi';
        body = 'Bu hesap silinmiş. Yeniden başlamak için tekrar kayıt olun.';
      } else {
        title = 'Oturum geçersiz';
        body = 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.';
      }
      SocketService.instance.disconnect();
      await showDialog(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(
                onPressed: () => Navigator.of(ctx).pop(), child: const Text('Tamam')),
          ],
        ),
      );
      if (mounted) _logoutToOnboarding();
    }));
  }

  void _logoutToOnboarding() async {
    SocketService.instance.disconnect();
    await Session.instance.logout();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const OnboardingScreen()),
      (_) => false,
    );
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    SocketService.instance.disconnect();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      const DiscoverScreen(),
      ChatsScreen(onSeen: () => setState(() => _unreadTotal = 0)),
      const ProfileScreen(),
    ];
    return Scaffold(
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        backgroundColor: Brand.surface,
        indicatorColor: Brand.primary.withValues(alpha: 0.25),
        onDestinationSelected: (i) => setState(() {
          _tab = i;
          if (i == 1) _unreadTotal = 0;
        }),
        destinations: [
          const NavigationDestination(
            icon: Icon(Icons.explore_outlined),
            selectedIcon: Icon(Icons.explore_rounded),
            label: 'Keşfet',
          ),
          NavigationDestination(
            icon: Badge(
              isLabelVisible: _unreadTotal > 0,
              label: Text('$_unreadTotal'),
              child: const Icon(Icons.chat_bubble_outline_rounded),
            ),
            selectedIcon: const Icon(Icons.chat_bubble_rounded),
            label: 'Sohbetler',
          ),
          const NavigationDestination(
            icon: Icon(Icons.person_outline_rounded),
            selectedIcon: Icon(Icons.person_rounded),
            label: 'Profil',
          ),
        ],
      ),
    );
  }
}
