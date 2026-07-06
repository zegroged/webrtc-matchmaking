import 'package:flutter/material.dart';
import '../config.dart';
import '../theme.dart';

/// Ortak avatar: profil fotoğrafı varsa gösterir, yoksa isimden renkli
/// baş harf üretir. Fotoğraf yüklenemezse baş harfe geri düşer.
class UserAvatar extends StatelessWidget {
  final String name;
  final String? avatarUrl;
  final double radius;

  const UserAvatar({
    super.key,
    required this.name,
    this.avatarUrl,
    this.radius = 26,
  });

  @override
  Widget build(BuildContext context) {
    final initial = name.isNotEmpty ? name[0].toUpperCase() : '?';
    final fallback = CircleAvatar(
      radius: radius,
      backgroundColor: avatarColor(name),
      child: Text(
        initial,
        style: TextStyle(
          fontSize: radius * 0.8,
          fontWeight: FontWeight.w800,
          color: Colors.white,
        ),
      ),
    );
    if (avatarUrl == null || avatarUrl!.isEmpty) return fallback;

    // Sunucu göreli yol döndürür (/avatars/...); mutlak URL'ye çevir.
    final url = avatarUrl!.startsWith('http')
        ? avatarUrl!
        : '${AppConfig.serverUrl}${avatarUrl!}';
    return CircleAvatar(
      radius: radius,
      backgroundColor: avatarColor(name),
      foregroundImage: NetworkImage(url),
      onForegroundImageError: (_, _) {},
      child: Text(
        initial,
        style: TextStyle(
          fontSize: radius * 0.8,
          fontWeight: FontWeight.w800,
          color: Colors.white,
        ),
      ),
    );
  }
}
