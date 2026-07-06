import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../api_client.dart';
import '../config.dart';
import '../models.dart';
import '../session.dart';
import '../theme.dart';
import 'home_shell.dart';

/// Onboarding: telefon -> SMS kodu -> profil (isim, doğum tarihi, dil, ilgi).
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  int _step = 0; // 0: telefon, 1: kod, 2: profil
  bool _busy = false;

  final _phoneCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _serverCtrl = TextEditingController(text: AppConfig.serverUrl);

  String? _devCode; // dev modunda API'nin döndürdüğü kod (ipucu olarak gösterilir)
  String? _registrationToken;
  DateTime? _birthDate;
  final Set<String> _langs = {'tr'};
  final Set<String> _interests = {};

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _codeCtrl.dispose();
    _nameCtrl.dispose();
    _serverCtrl.dispose();
    super.dispose();
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Brand.danger : null, // null -> tema varsayılanı
    ));
  }

  Future<void> _run(Future<void> Function() fn) async {
    setState(() => _busy = true);
    try {
      await fn();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } catch (e) {
      _toast('Sunucuya ulaşılamadı. Adresi ve bağlantınızı kontrol edin.', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _requestOtp() => _run(() async {
        if (!kIsWeb) await AppConfig.setServerUrl(_serverCtrl.text);
        final res = await ApiClient.post('/api/auth/request-otp', {'phone': _phoneCtrl.text});
        _devCode = res['devCode'] as String?;
        setState(() => _step = 1);
      });

  Future<void> _verifyOtp() => _run(() async {
        final res = await ApiClient.post('/api/auth/verify-otp', {
          'phone': _phoneCtrl.text,
          'code': _codeCtrl.text.trim(),
        });
        if (res['needsProfile'] == true) {
          _registrationToken = res['registrationToken'] as String;
          setState(() => _step = 2);
        } else {
          final user = User.fromJson(Map<String, dynamic>.from(res['user']));
          await Session.instance.login(res['token'] as String, user);
          _goHome();
        }
      });

  Future<void> _completeProfile() => _run(() async {
        if (_birthDate == null) {
          _toast('Doğum tarihinizi seçin.', error: true);
          return;
        }
        if (_interests.length != 3) {
          _toast('Tam olarak 3 ilgi alanı seçin.', error: true);
          return;
        }
        final bd = '${_birthDate!.year.toString().padLeft(4, '0')}-'
            '${_birthDate!.month.toString().padLeft(2, '0')}-'
            '${_birthDate!.day.toString().padLeft(2, '0')}';
        final res = await ApiClient.post('/api/auth/complete-profile', {
          'registrationToken': _registrationToken,
          'displayName': _nameCtrl.text.trim(),
          'birthDate': bd,
          'languages': _langs.toList(),
          'interests': _interests.toList(),
        });
        final user = User.fromJson(Map<String, dynamic>.from(res['user']));
        await Session.instance.login(res['token'] as String, user);
        _goHome();
      });

  void _goHome() {
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const HomeShell()));
  }

  Future<void> _pickBirthDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(now.year - 20, 1, 1),
      firstDate: DateTime(now.year - 100),
      lastDate: now,
      helpText: 'Doğum tarihinizi seçin',
      locale: const Locale('tr'),
    );
    if (picked != null) setState(() => _birthDate = picked);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.all(24),
              children: [
                _header(),
                const SizedBox(height: 32),
                if (_step == 0) ..._phoneStep(),
                if (_step == 1) ..._codeStep(),
                if (_step == 2) ..._profileStep(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _header() {
    const titles = ['Hoş geldin 👋', 'Kodu gir 💬', 'Kendini tanıt ✨'];
    const subs = [
      'Telefon numaranla saniyeler içinde başla.',
      'Numarana gönderdiğimiz 6 haneli kodu gir.',
      'Bu bilgiler daha iyi eşleşmeler için kullanılır.',
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: List.generate(3, (i) {
            return Expanded(
              child: Container(
                height: 4,
                margin: EdgeInsets.only(right: i < 2 ? 8 : 0),
                decoration: BoxDecoration(
                  color: i <= _step ? Brand.primary : Brand.surfaceHigh,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            );
          }),
        ),
        const SizedBox(height: 28),
        Text(titles[_step],
            style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Text(subs[_step], style: const TextStyle(color: Brand.textDim, fontSize: 15)),
      ],
    );
  }

  List<Widget> _phoneStep() {
    return [
      TextField(
        controller: _phoneCtrl,
        keyboardType: TextInputType.phone,
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d+\s]'))],
        decoration: const InputDecoration(
          hintText: '05xx xxx xx xx',
          prefixIcon: Icon(Icons.phone_rounded, color: Brand.textDim),
        ),
        onSubmitted: (_) => _busy ? null : _requestOtp(),
      ),
      const SizedBox(height: 12),
      if (!kIsWeb)
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          shape: const Border(),
          title: const Text('Sunucu adresi (geliştirici)',
              style: TextStyle(color: Brand.textDim, fontSize: 13)),
          children: [
            TextField(
              controller: _serverCtrl,
              decoration: const InputDecoration(hintText: 'http://192.168.1.20:3000'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: _busy ? null : _requestOtp,
        child: _busy
            ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
            : const Text('Kod Gönder'),
      ),
      const SizedBox(height: 20),
      const Text(
        'Devam ederek 18 yaşından büyük olduğunuzu, Kullanım Koşulları ve Gizlilik Politikası\'nı kabul ettiğinizi onaylarsınız.',
        style: TextStyle(color: Brand.textDim, fontSize: 12),
        textAlign: TextAlign.center,
      ),
    ];
  }

  List<Widget> _codeStep() {
    return [
      TextField(
        controller: _codeCtrl,
        keyboardType: TextInputType.number,
        maxLength: 6,
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 24, letterSpacing: 12, fontWeight: FontWeight.w700),
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        decoration: const InputDecoration(hintText: '••••••', counterText: ''),
        onSubmitted: (_) => _busy ? null : _verifyOtp(),
      ),
      if (_devCode != null) ...[
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Brand.warning.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            '🛠 Geliştirme modu — SMS gönderilmedi.\nKodunuz: $_devCode',
            style: const TextStyle(color: Brand.warning, fontSize: 13),
            textAlign: TextAlign.center,
          ),
        ),
      ],
      const SizedBox(height: 16),
      FilledButton(
        onPressed: _busy ? null : _verifyOtp,
        child: _busy
            ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
            : const Text('Doğrula'),
      ),
      const SizedBox(height: 8),
      TextButton(
        onPressed: _busy ? null : () => setState(() => _step = 0),
        child: const Text('Numarayı değiştir', style: TextStyle(color: Brand.textDim)),
      ),
    ];
  }

  List<Widget> _profileStep() {
    return [
      TextField(
        controller: _nameCtrl,
        maxLength: 30,
        decoration: const InputDecoration(
          hintText: 'Görünen adın',
          counterText: '',
          prefixIcon: Icon(Icons.person_rounded, color: Brand.textDim),
        ),
      ),
      const SizedBox(height: 12),
      InkWell(
        onTap: _pickBirthDate,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          decoration: BoxDecoration(
            color: Brand.surface,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: [
              const Icon(Icons.cake_rounded, color: Brand.textDim),
              const SizedBox(width: 12),
              Text(
                _birthDate == null
                    ? 'Doğum tarihin'
                    : '${_birthDate!.day.toString().padLeft(2, '0')}.${_birthDate!.month.toString().padLeft(2, '0')}.${_birthDate!.year}',
                style: TextStyle(
                  color: _birthDate == null ? Brand.textDim : Brand.text,
                  fontSize: 16,
                ),
              ),
              const Spacer(),
              const Icon(Icons.lock_rounded, size: 16, color: Brand.textDim),
            ],
          ),
        ),
      ),
      const SizedBox(height: 6),
      const Text('Doğum tarihi kayıttan sonra değiştirilemez.',
          style: TextStyle(color: Brand.textDim, fontSize: 12)),
      const SizedBox(height: 20),
      const Text('Konuştuğun diller',
          style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
      const SizedBox(height: 10),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: Catalog.languages.entries.map((e) {
          final selected = _langs.contains(e.key);
          return FilterChip(
            label: Text(e.value),
            selected: selected,
            onSelected: (v) => setState(() {
              if (v) {
                _langs.add(e.key);
              } else if (_langs.length > 1) {
                _langs.remove(e.key);
              }
            }),
          );
        }).toList(),
      ),
      const SizedBox(height: 20),
      Row(
        children: [
          const Text('İlgi alanların',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
          const Spacer(),
          Text('${_interests.length}/3',
              style: TextStyle(
                  color: _interests.length == 3 ? Brand.success : Brand.textDim,
                  fontWeight: FontWeight.w700)),
        ],
      ),
      const SizedBox(height: 10),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: Catalog.interests.entries.map((e) {
          final selected = _interests.contains(e.key);
          return FilterChip(
            label: Text('${e.value.emoji} ${e.value.label}'),
            selected: selected,
            onSelected: (v) => setState(() {
              if (v && _interests.length < 3) {
                _interests.add(e.key);
              } else if (!v) {
                _interests.remove(e.key);
              }
            }),
          );
        }).toList(),
      ),
      const SizedBox(height: 24),
      FilledButton(
        onPressed: _busy ? null : _completeProfile,
        child: _busy
            ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
            : const Text('Başla 🚀'),
      ),
    ];
  }
}
