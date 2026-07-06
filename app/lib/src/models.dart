/// Backend API sözleşmesiyle birebir eşleşen veri modelleri.
class User {
  final int id;
  final String displayName;
  final String birthDate;
  final int age;
  final List<String> languages;
  final List<String> interests;
  final String status;

  User({
    required this.id,
    required this.displayName,
    required this.birthDate,
    required this.age,
    required this.languages,
    required this.interests,
    required this.status,
  });

  factory User.fromJson(Map<String, dynamic> j) => User(
        id: j['id'] as int,
        displayName: j['displayName'] as String,
        birthDate: j['birthDate'] as String? ?? '',
        age: j['age'] as int? ?? 0,
        languages: List<String>.from(j['languages'] ?? const []),
        interests: List<String>.from(j['interests'] ?? const []),
        status: j['status'] as String? ?? 'active',
      );
}

/// Eşleşmede karşı tarafın görünen kısıtlı profili.
class PeerProfile {
  final int id;
  final String displayName;
  final int age;
  final List<String> interests;
  final List<String> languages;

  PeerProfile({
    required this.id,
    required this.displayName,
    required this.age,
    required this.interests,
    required this.languages,
  });

  factory PeerProfile.fromJson(Map<String, dynamic> j) => PeerProfile(
        id: j['id'] as int,
        displayName: j['displayName'] as String? ?? '?',
        age: j['age'] as int? ?? 0,
        interests: List<String>.from(j['interests'] ?? const []),
        languages: List<String>.from(j['languages'] ?? const []),
      );
}

class MatchInfo {
  final int matchId;
  final PeerProfile peer;
  final List<String> commonInterests;
  final String icebreaker;
  final bool initiator;

  MatchInfo({
    required this.matchId,
    required this.peer,
    required this.commonInterests,
    required this.icebreaker,
    required this.initiator,
  });

  factory MatchInfo.fromJson(Map<String, dynamic> j) => MatchInfo(
        matchId: j['matchId'] as int,
        peer: PeerProfile.fromJson(Map<String, dynamic>.from(j['peer'])),
        commonInterests: List<String>.from(j['commonInterests'] ?? const []),
        icebreaker: j['icebreaker'] as String? ?? '',
        initiator: j['initiator'] as bool? ?? false,
      );
}

class FriendEntry {
  final int friendshipId;
  final PeerProfile friend;
  final bool deleted;
  String? lastMessageBody;
  int? lastMessageSenderId;
  int? lastMessageAt;
  int unread;
  bool online;

  FriendEntry({
    required this.friendshipId,
    required this.friend,
    required this.deleted,
    this.lastMessageBody,
    this.lastMessageSenderId,
    this.lastMessageAt,
    this.unread = 0,
    this.online = false,
  });

  factory FriendEntry.fromJson(Map<String, dynamic> j) {
    final f = Map<String, dynamic>.from(j['friend']);
    final last = j['lastMessage'] as Map<String, dynamic>?;
    return FriendEntry(
      friendshipId: j['friendshipId'] as int,
      friend: PeerProfile(
        id: f['id'] as int,
        displayName: f['displayName'] as String? ?? '?',
        age: f['age'] as int? ?? 0,
        interests: List<String>.from(f['interests'] ?? const []),
        languages: const [],
      ),
      deleted: f['deleted'] as bool? ?? false,
      lastMessageBody: last?['body'] as String?,
      lastMessageSenderId: last?['senderId'] as int?,
      lastMessageAt: last?['createdAt'] as int?,
      unread: j['unread'] as int? ?? 0,
    );
  }
}

class ChatMessage {
  final int id;
  final int friendshipId;
  final int senderId;
  final String body;
  final bool flagged;
  final int createdAt;
  int? readAt;

  ChatMessage({
    required this.id,
    required this.friendshipId,
    required this.senderId,
    required this.body,
    required this.flagged,
    required this.createdAt,
    this.readAt,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: j['id'] as int,
        friendshipId: j['friendshipId'] as int? ?? 0,
        senderId: j['senderId'] as int,
        body: j['body'] as String,
        flagged: j['flagged'] == true,
        createdAt: j['createdAt'] as int,
        readAt: j['readAt'] as int?,
      );
}
