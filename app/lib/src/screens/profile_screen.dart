import 'package:flutter/material.dart';
import '../api_client.dart';
import '../config.dart';
import '../session.dart';
import '../socket_service.dart';
import '../theme.dart';
import 'onboarding_screen.dart';

/// Profil ve ayarlar: isim/dil/ilgi düzenleme, kilitli doğum tarihi,
/// çıkış ve hesap silme (mağaza zorunluluğu).
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  bool _busy = false;

  Future<void> _editName() async {
    final user = Session.instance.user!;
    final ctrl = TextEditingController(text: user.displayName);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Görünen adını değiştir'),
        content: TextField(
          controller: ctrl,
          maxLength: 30,
          autofocus: true,
          decoration: const InputDecoration(counterText: ''),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Vazgeç')),
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Kaydet')),
        ],
      ),
    );
    if (ok == true && mounted) {
      await _save({'displayName': ctrl.text.trim()});
    }
  }

  Future<void> _editLanguages() async {
    final user = Session.instance.user!;
    final selected = Set<String>.from(user.languages);
    final ok = await _chipPicker(
      title: 'Konuştuğun diller',
      options: Catalog.languages.map((k, v) => MapEntry(k, v)),
      selected: selected,
      min: 1,
      max: Catalog.languages.length,
    );
    if (ok && mounted) await _save({'languages': selected.toList()});
  }

  Future<void> _editInterests() async {
    final user = Session.instance.user!;
    final selected = Set<String>.from(user.interests);
    final ok = await _chipPicker(
      title: 'İlgi alanların (3 adet)',
      options: Catalog.interests
          .map((k, v) => MapEntry(k, '${v.emoji} ${v.label}')),
      selected: selected,
      min: 3,
      max: 3,
    );
    if (ok && mounted) await _save({'interests': selected.toList()});
  }

  Future<bool> _chipPicker({
    required String title,
    required Map<String, String> options,
    required Set<String> selected,
    required int min,
    required int max,
  }) async {
    final res = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setD) => AlertDialog(
          title: Text(title),
          content: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: options.entries.map((e) {
              final sel = selected.contains(e.key);
              return FilterChip(
                label: Text(e.value),
                selected: sel,
                onSelected: (v) => setD(() {
                  if (v) {
                    if (selected.length < max) selected.add(e.key);
                  } else {
                    if (selected.length > min) selected.remove(e.key);
                  }
                }),
              );
            }).toList(),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('Vazgeç')),
            TextButton(
                onPressed: selected.length >= min
                    ? () => Navigator.of(ctx).pop(true)
                    : null,
                child: const Text('Kaydet')),
          ],
        ),
      ),
    );
    return res == true;
  }

  Future<void> _save(Map<String, dynamic> body) async {
    setState(() => _busy = true);
    try {
      await ApiClient.put('/api/me', body);
      await Session.instance.refreshProfile();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: Brand.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _logout() async {
    SocketService.instance.disconnect();
    await Session.instance.logout();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const OnboardingScreen()),
      (_) => false,
    );
  }

  Future<void> _deleteAccount() async {
    final first = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Hesabı sil'),
        content: const Text(
            'Hesabınız, arkadaşlıklarınız ve tüm mesajlarınız kalıcı olarak silinecek. Bu işlem geri alınamaz.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Vazgeç')),
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Devam', style: TextStyle(color: Brand.danger))),
        ],
      ),
    );
    if (first != true || !mounted) return;

    final ctrl = TextEditingController();
    final second = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Emin misiniz?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Onaylamak için kutuya SİL yazın.'),
            const SizedBox(height: 12),
            TextField(controller: ctrl, autofocus: true),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Vazgeç')),
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Hesabı Sil',
                  style: TextStyle(color: Brand.danger))),
        ],
      ),
    );
    if (second != true || ctrl.text.trim().toUpperCase() != 'SİL' || !mounted) {
      if (second == true && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Onay metni eşleşmedi, hesabınız silinmedi.')));
      }
      return;
    }

    setState(() => _busy = true);
    try {
      SocketService.instance.disconnect();
      await Session.instance.deleteAccount();
      if (!mounted) return;
      Navigator.of(context).pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const OnboardingScreen()),
        (_) => false,
      );
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: Brand.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = Session.instance.user;
    if (user == null) return const SizedBox.shrink();
    return Scaffold(
      appBar: AppBar(title: const Text('Profil')),
      body: ListenableBuilder(
        listenable: Session.instance,
        builder: (context, _) {
          final u = Session.instance.user;
          if (u == null) return const SizedBox.shrink();
          return ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Center(
                child: Column(
                  children: [
                    CircleAvatar(
                      radius: 44,
                      backgroundColor: avatarColor(u.displayName),
                      child: Text(
                        u.displayName.isNotEmpty
                            ? u.displayName[0].toUpperCase()
                            : '?',
                        style: const TextStyle(
                            fontSize: 36,
                            fontWeight: FontWeight.w800,
                            color: Colors.white),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text('${u.displayName}, ${u.age}',
                        style: const TextStyle(
                            fontSize: 22, fontWeight: FontWeight.w800)),
                  ],
                ),
              ),
              const SizedBox(height: 24),
              _sectionTitle('Hesap'),
              _tile(
                icon: Icons.badge_rounded,
                title: 'Görünen ad',
                subtitle: u.displayName,
                onTap: _busy ? null : _editName,
              ),
              _tile(
                icon: Icons.cake_rounded,
                title: 'Doğum tarihi',
                subtitle: '${u.birthDate}  •  değiştirilemez',
                trailing: const Icon(Icons.lock_rounded,
                    size: 18, color: Brand.textDim),
              ),
              _tile(
                icon: Icons.translate_rounded,
                title: 'Diller',
                subtitle: u.languages
                    .map((l) => Catalog.languages[l] ?? l)
                    .join(', '),
                onTap: _busy ? null : _editLanguages,
              ),
              _tile(
                icon: Icons.interests_rounded,
                title: 'İlgi alanları',
                subtitle: u.interests
                    .map((i) => Catalog.interests[i]?.label ?? i)
                    .join(', '),
                onTap: _busy ? null : _editInterests,
              ),
              const SizedBox(height: 24),
              _sectionTitle('Güvenlik'),
              _tile(
                icon: Icons.shield_rounded,
                title: 'Topluluk kuralları',
                subtitle: '18+ platform • saygı esastır • ihlaller kalıcı ban',
                onTap: () => showDialog(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('Topluluk Kuralları'),
                    content: const SingleChildScrollView(
                      child: Text(
                        '1. Proje X yalnızca 18 yaş ve üzeri içindir.\n\n'
                        '2. Çıplaklık, cinsel içerik, şiddet, nefret söylemi ve taciz kesinlikle yasaktır.\n\n'
                        '3. Görüşmeler kaydedilmez; ancak rapor edilen anlardan kanıt karesi alınır ve moderasyon ekibince incelenir.\n\n'
                        '4. Kurallara aykırılık, hesabın askıya alınması veya kalıcı olarak kapatılmasıyla sonuçlanır.\n\n'
                        '5. Kendinizi güvende hissetmediğiniz her durumda "Raporla" butonunu kullanın.',
                      ),
                    ),
                    actions: [
                      TextButton(
                          onPressed: () => Navigator.of(ctx).pop(),
                          child: const Text('Tamam')),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 24),
              _sectionTitle('Oturum'),
              _tile(
                icon: Icons.logout_rounded,
                title: 'Çıkış yap',
                onTap: _busy ? null : _logout,
              ),
              _tile(
                icon: Icons.delete_forever_rounded,
                title: 'Hesabı kalıcı olarak sil',
                titleColor: Brand.danger,
                onTap: _busy ? null : _deleteAccount,
              ),
              const SizedBox(height: 20),
              const Center(
                child: Text('Proje X v0.1.0 (beta)',
                    style: TextStyle(color: Brand.textDim, fontSize: 12)),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _sectionTitle(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8, left: 4),
        child: Text(text,
            style: const TextStyle(
                color: Brand.textDim,
                fontSize: 13,
                fontWeight: FontWeight.w700)),
      );

  Widget _tile({
    required IconData icon,
    required String title,
    String? subtitle,
    Color? titleColor,
    Widget? trailing,
    VoidCallback? onTap,
  }) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        onTap: onTap,
        leading: Icon(icon, color: titleColor ?? Brand.primary),
        title: Text(title,
            style: TextStyle(
                color: titleColor, fontWeight: FontWeight.w600, fontSize: 15)),
        subtitle: subtitle != null
            ? Text(subtitle,
                style: const TextStyle(color: Brand.textDim, fontSize: 13))
            : null,
        trailing: trailing ??
            (onTap != null
                ? const Icon(Icons.chevron_right_rounded, color: Brand.textDim)
                : null),
      ),
    );
  }
}
