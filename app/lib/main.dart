import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'src/config.dart';
import 'src/session.dart';
import 'src/theme.dart';
import 'src/screens/onboarding_screen.dart';
import 'src/screens/home_shell.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppConfig.load();
  runApp(const ProjeXApp());
}

class ProjeXApp extends StatelessWidget {
  const ProjeXApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Proje X',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      locale: const Locale('tr'),
      supportedLocales: const [Locale('tr'), Locale('en')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: const BootScreen(),
    );
  }
}

/// Açılış: kayıtlı oturum varsa doğrudan ana ekrana, yoksa onboarding'e.
class BootScreen extends StatefulWidget {
  const BootScreen({super.key});

  @override
  State<BootScreen> createState() => _BootScreenState();
}

class _BootScreenState extends State<BootScreen> {
  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final ok = await Session.instance.restore();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(MaterialPageRoute(
      builder: (_) => ok ? const HomeShell() : const OnboardingScreen(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 88,
              height: 88,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Brand.primary, Brand.secondary],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(26),
              ),
              child: const Icon(Icons.videocam_rounded, size: 44, color: Colors.white),
            ),
            const SizedBox(height: 20),
            const Text('Proje X',
                style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            const Text('Rastgele tanış, gerçek bağ kur',
                style: TextStyle(color: Brand.textDim)),
            const SizedBox(height: 32),
            const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2.5),
            ),
          ],
        ),
      ),
    );
  }
}
