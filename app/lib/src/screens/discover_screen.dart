import 'dart:async';
import 'package:flutter/material.dart';
import '../config.dart';
import '../models.dart';
import '../session.dart';
import '../socket_service.dart';
import '../theme.dart';
import 'call_screen.dart';

/// Keşfet: mod seç -> "Eşleşme Bul" -> arama animasyonu -> eşleşince CallScreen.
class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen>
    with SingleTickerProviderStateMixin {
  String _mood = 'hafif';
  bool _searching = false;
  int _waitSeconds = 0;
  Timer? _waitTimer;
  StreamSubscription? _matchSub;
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: const Duration(seconds: 2))
      ..repeat();
    _matchSub = SocketService.instance.matchFound.listen(_onMatchFound);
  }

  @override
  void dispose() {
    _waitTimer?.cancel();
    _matchSub?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  Future<void> _startSearch() async {
    final res = await SocketService.instance.joinQueue(_mood);
    if (!mounted) return;
    if (res['ok'] != true) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text((res['message'] as String?) ?? 'Kuyruğa katılınamadı.'),
        backgroundColor: Brand.danger,
      ));
      return;
    }
    setState(() {
      _searching = true;
      _waitSeconds = 0;
    });
    _waitTimer?.cancel();
    _waitTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _waitSeconds++);
    });
  }

  Future<void> _cancelSearch() async {
    await SocketService.instance.leaveQueue();
    _stopSearchUi();
  }

  void _stopSearchUi() {
    _waitTimer?.cancel();
    if (mounted) setState(() => _searching = false);
  }

  Future<void> _onMatchFound(MatchInfo match) async {
    if (!mounted || !_searching) return;
    _stopSearchUi();
    // Görüşme ekranına geç; dönüşte 'requeue' gelirse otomatik yeni arama başlat.
    final result = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => CallScreen(match: match, mood: _mood)),
    );
    if (result == 'requeue' && mounted) {
      _startSearch();
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = Session.instance.user;
    return Scaffold(
      body: SafeArea(
        child: _searching ? _searchingView() : _idleView(user?.displayName ?? ''),
      ),
    );
  }

  Widget _idleView(String name) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(24),
          children: [
            Text('Merhaba, $name 👋',
                style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            const Text('Bugün modun ne?',
                style: TextStyle(color: Brand.textDim, fontSize: 15)),
            const SizedBox(height: 20),
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1.45,
              children: Catalog.moods.entries.map((e) {
                final selected = _mood == e.key;
                return InkWell(
                  onTap: () => setState(() => _mood = e.key),
                  borderRadius: BorderRadius.circular(18),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: selected
                          ? Brand.primary.withValues(alpha: 0.18)
                          : Brand.surface,
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(
                        color: selected ? Brand.primary : Colors.transparent,
                        width: 2,
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(e.value.emoji, style: const TextStyle(fontSize: 26)),
                        const SizedBox(height: 6),
                        Text(e.value.label,
                            style: const TextStyle(
                                fontWeight: FontWeight.w700, fontSize: 14)),
                        const SizedBox(height: 2),
                        Text(e.value.desc,
                            style: const TextStyle(
                                color: Brand.textDim, fontSize: 11),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis),
                      ],
                    ),
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 28),
            SizedBox(
              height: 60,
              child: FilledButton(
                onPressed: _startSearch,
                style: FilledButton.styleFrom(
                  backgroundColor: Brand.primary,
                  textStyle:
                      const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                ),
                child: const Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.videocam_rounded),
                    SizedBox(width: 10),
                    Text('Eşleşme Bul'),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 14),
            const Text(
              'Kamera ve mikrofon izni istenecektir. Topluluk kurallarına uymayan\nkullanıcıları görüşme sırasında raporlayabilirsin.',
              style: TextStyle(color: Brand.textDim, fontSize: 12),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  Widget _searchingView() {
    final mood = Catalog.moods[_mood]!;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          AnimatedBuilder(
            animation: _pulse,
            builder: (context, child) {
              return Stack(
                alignment: Alignment.center,
                children: [
                  for (var i = 0; i < 3; i++)
                    Container(
                      width: 120 + 90 * ((_pulse.value + i / 3) % 1),
                      height: 120 + 90 * ((_pulse.value + i / 3) % 1),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: Brand.primary.withValues(
                              alpha: 0.5 * (1 - ((_pulse.value + i / 3) % 1))),
                          width: 2,
                        ),
                      ),
                    ),
                  Container(
                    width: 110,
                    height: 110,
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(
                        colors: [Brand.primary, Brand.secondary],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                    ),
                    child: Center(
                      child: Text(mood.emoji, style: const TextStyle(fontSize: 44)),
                    ),
                  ),
                ],
              );
            },
          ),
          const SizedBox(height: 36),
          const Text('Sana uygun biri aranıyor...',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text('${mood.label} • ${_waitSeconds}s',
              style: const TextStyle(color: Brand.textDim)),
          const SizedBox(height: 6),
          if (_waitSeconds > 12)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 40),
              child: Text(
                'Kriterler genişletiliyor, birazdan eşleşeceksin...',
                style: TextStyle(color: Brand.textDim, fontSize: 13),
                textAlign: TextAlign.center,
              ),
            ),
          const SizedBox(height: 40),
          OutlinedButton(
            onPressed: _cancelSearch,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(180, 48),
            ),
            child: const Text('İptal'),
          ),
        ],
      ),
    );
  }
}
