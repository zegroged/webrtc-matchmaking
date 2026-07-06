import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import '../api_client.dart';
import '../config.dart';
import '../models.dart';
import '../socket_service.dart';
import '../theme.dart';
import '../widgets/user_avatar.dart';

/// Görüntülü görüşme ekranı: WebRTC P2P + sinyalleşme, buzkıran sorusu,
/// Geç / Bitir / Raporla / Arkadaş Ekle aksiyonları ve görüşme sonu kartı.
class CallScreen extends StatefulWidget {
  final MatchInfo match;
  final String mood;
  const CallScreen({super.key, required this.match, required this.mood});

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  final _localRenderer = RTCVideoRenderer();
  final _remoteRenderer = RTCVideoRenderer();
  RTCPeerConnection? _pc;
  MediaStream? _localStream;
  MediaStream? _remoteStream;

  final _subs = <StreamSubscription>[];
  Timer? _durationTimer;
  int _seconds = 0;

  bool _micOn = true;
  bool _camOn = true;
  bool _remoteConnected = false; // karşı taraftan video/ses akışı geldi
  bool _pcConnected = false;     // P2P bağlantı kuruldu (medya olmasa bile)
  bool _showIcebreaker = true;
  bool _friendRequested = false;
  bool _friendsNow = false;
  bool _mediaError = false;
  bool _retryingMedia = false;

  // WebRTC sinyal senkronizasyonu: PeerConnection hazır olmadan gelen sinyaller
  // ve remoteDescription set edilmeden gelen ICE adayları kaybedilmesin diye
  // tamponlanır (aksi halde ilk kullanımda kamera izni diyalogu açıkken gelen
  // offer düşer ve görüşme hiç kurulamaz).
  final List<Map<String, dynamic>> _pendingSignals = [];
  final List<Map<String, dynamic>> _pendingCandidates = [];
  bool _remoteDescSet = false;
  bool _needsRenegotiation = false; // stable olunca yeni teklif gönderilecek mi
  bool _reportSheetOpen = false;

  // Görüşme sonu durumu
  bool _ended = false;
  String _endReason = '';
  bool _endedByPeer = false;
  bool _canAddFriend = true;
  int _finalDuration = 0;

  @override
  void initState() {
    super.initState();
    _subs.add(SocketService.instance.rtcSignal.listen(_onSignal));
    _subs.add(SocketService.instance.matchEnded.listen(_onMatchEnded));
    _subs.add(SocketService.instance.friendNew.listen(_onFriendNew));
    // Görüşme sırasında bağlantı koparsa sunucu match:ended'i iletemez; kullanıcı
    // ekranda hapsolmasın diye yerel olarak bitiş kartını göster.
    _subs.add(SocketService.instance.connectionState.listen((up) {
      if (!up && !_ended && mounted) {
        _closeMedia();
        setState(() {
          _ended = true;
          _endReason = 'disconnect';
          _endedByPeer = false;
          _canAddFriend = false;
          _finalDuration = _seconds;
        });
      }
    }));
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && !_ended) setState(() => _seconds++);
    });
    _initCall();
  }

  Future<void> _initCall() async {
    await _localRenderer.initialize();
    await _remoteRenderer.initialize();

    // ICE sunucuları backend'den alınır (STUN + varsa TURN).
    List<dynamic> iceServers = [
      {'urls': 'stun:stun.l.google.com:19302'},
    ];
    try {
      final cfg = await ApiClient.get('/api/rtc-config');
      iceServers = cfg['iceServers'] as List<dynamic>;
    } catch (_) {}

    try {
      _localStream = await navigator.mediaDevices.getUserMedia({
        'audio': true,
        'video': {
          'facingMode': 'user',
          'width': {'ideal': 640},
          'height': {'ideal': 480},
        },
      });
      _applyTrackToggles(_localStream!); // kullanıcı izin beklerken toggle'a bastıysa uygula
      _localRenderer.srcObject = _localStream;
    } catch (e) {
      // Kamera/mikrofon reddedildi: görüşme sinyalleşmesi yine kurulur,
      // kullanıcı uyarılır.
      if (mounted) setState(() => _mediaError = true);
    }

    final pc = await createPeerConnection({'iceServers': iceServers});
    _pc = pc;

    if (_localStream != null) {
      for (final t in _localStream!.getTracks()) {
        await pc.addTrack(t, _localStream!);
      }
    } else {
      // Kamera/mikrofon izni yoksa bile SDP'de medya kanalları bulunmalı;
      // aksi halde teklif boş gider ve iki taraf da "Bağlanıyor..."da kalır.
      // recvonly transceiver'lar karşı tarafın görüntü/sesini tek yönlü almayı
      // sağlar.
      await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
      );
      await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
      );
    }

    pc.onTrack = (event) {
      if (event.streams.isNotEmpty) {
        _remoteStream = event.streams[0];
        _remoteRenderer.srcObject = _remoteStream;
        if (mounted) setState(() => _remoteConnected = true);
      }
    };
    pc.onIceCandidate = (candidate) {
      SocketService.instance.sendSignal(widget.match.matchId, {
        'candidate': candidate.toMap(),
      });
    };
    // Bağlantı kurulduğunda (karşı tarafın kamerası kapalı olsa bile)
    // "Bağlanıyor..." yerine doğru durumu gösterebilmek için izlenir.
    pc.onConnectionState = (state) {
      if (!mounted) return;
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        setState(() => _pcConnected = true);
      }
    };
    pc.onIceConnectionState = (state) {
      if (!mounted) return;
      if (state == RTCIceConnectionState.RTCIceConnectionStateConnected ||
          state == RTCIceConnectionState.RTCIceConnectionStateCompleted) {
        setState(() => _pcConnected = true);
      }
    };

    if (widget.match.initiator) {
      await _sendOffer(pc);
    }

    // PeerConnection hazır olmadan biriken sinyalleri şimdi sırayla işle.
    final queued = List<Map<String, dynamic>>.from(_pendingSignals);
    _pendingSignals.clear();
    for (final data in queued) {
      await _applySignal(pc, data);
    }
    if (mounted) setState(() {});
  }

  bool get _isInitiator => widget.match.initiator;

  /// Teklif ÜRETİMİ yalnızca başlatan (initiator) tarafta yapılır. Bu, iki
  /// tarafın aynı anda teklif göndermesinden (glare) doğan kalıcı kilitlenmeleri
  /// tümden ortadan kaldırır: tek yönlü teklif akışı = çakışma imkânsız.
  /// Sinyalleşme "stable" değilse teklif ertelenir, cevap gelince tetiklenir.
  Future<void> _sendOffer(RTCPeerConnection pc) async {
    if (!_isInitiator) return;
    if (pc.signalingState !=
        RTCSignalingState.RTCSignalingStateStable) {
      _needsRenegotiation = true;
      return;
    }
    try {
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      SocketService.instance.sendSignal(widget.match.matchId, {
        'type': 'offer',
        'sdp': offer.sdp,
      });
    } catch (e) {
      debugPrint('offer üretim hatası: $e');
    }
  }

  Future<void> _onSignal(Map<String, dynamic> payload) async {
    if (payload['matchId'] != widget.match.matchId) return;
    final data = Map<String, dynamic>.from(payload['data'] ?? {});
    final pc = _pc;
    if (pc == null) {
      // PC henüz kurulmadı: sinyali tampona al, _initCall drenaj edecek.
      _pendingSignals.add(data);
      return;
    }
    await _applySignal(pc, data);
  }

  Future<void> _applySignal(RTCPeerConnection pc, Map<String, dynamic> data) async {
    try {
      // Non-initiator izin verince yeniden müzakere isteği gönderir; teklifi
      // her zaman initiator üretir (glare önleme).
      if (data['renegotiate'] == true) {
        await _sendOffer(pc);
        return;
      }
      if (data['type'] == 'offer') {
        await pc.setRemoteDescription(
            RTCSessionDescription(data['sdp'] as String, 'offer'));
        _remoteDescSet = true;
        await _flushPendingCandidates(pc);
        final answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        SocketService.instance.sendSignal(widget.match.matchId, {
          'type': 'answer',
          'sdp': answer.sdp,
        });
      } else if (data['type'] == 'answer') {
        // İstenmeyen/çift answer stable state'e çarparsa yok say (initiator-only
        // akışta tek geçerli answer beklenir).
        if (pc.signalingState !=
            RTCSignalingState.RTCSignalingStateHaveLocalOffer) {
          return;
        }
        await pc.setRemoteDescription(
            RTCSessionDescription(data['sdp'] as String, 'answer'));
        _remoteDescSet = true;
        await _flushPendingCandidates(pc);
        // Cevap uygulandı (stable); ertelediğimiz yeniden müzakere varsa şimdi yap.
        if (_needsRenegotiation) {
          _needsRenegotiation = false;
          await _sendOffer(pc);
        }
      } else if (data['candidate'] != null) {
        final c = Map<String, dynamic>.from(data['candidate']);
        // remoteDescription set edilmeden addCandidate hata verir; tamponla.
        if (!_remoteDescSet) {
          _pendingCandidates.add(c);
        } else {
          await pc.addCandidate(RTCIceCandidate(
            c['candidate'] as String?,
            c['sdpMid'] as String?,
            c['sdpMLineIndex'] as int?,
          ));
        }
      }
    } catch (e) {
      debugPrint('rtc signal hatası: $e');
    }
  }

  Future<void> _flushPendingCandidates(RTCPeerConnection pc) async {
    final pending = List<Map<String, dynamic>>.from(_pendingCandidates);
    _pendingCandidates.clear();
    for (final c in pending) {
      try {
        await pc.addCandidate(RTCIceCandidate(
          c['candidate'] as String?,
          c['sdpMid'] as String?,
          c['sdpMLineIndex'] as int?,
        ));
      } catch (e) {
        debugPrint('ICE aday hatası: $e');
      }
    }
  }

  void _onMatchEnded(Map<String, dynamic> data) {
    if (data['matchId'] != widget.match.matchId || _ended) return;
    final reason = data['reason'] as String? ?? '';
    _closeMedia();
    if (reason == 'skip') {
      // Geçildi: iki taraf da otomatik olarak yeni aramaya döner.
      // Rapor sayfası (bottom sheet) açıksa önce onu kapat, yoksa pop yanlış
      // rotayı hedefler ve tip hatasıyla çöker.
      if (mounted) {
        if (_reportSheetOpen) {
          Navigator.of(context).popUntil((r) => r.isFirst || r == ModalRoute.of(context));
          _reportSheetOpen = false;
        }
        Navigator.of(context).pop('requeue');
      }
      return;
    }
    if (mounted) {
      setState(() {
        _ended = true;
        _endReason = reason;
        _endedByPeer = data['byPeer'] == true;
        _canAddFriend = data['canAddFriend'] != false;
        _finalDuration = data['durationSec'] as int? ?? _seconds;
      });
    }
  }

  void _onFriendNew(Map<String, dynamic> data) {
    if (data['matchId'] == widget.match.matchId && mounted) {
      setState(() => _friendsNow = true);
    }
  }

  Future<void> _closeMedia() async {
    _durationTimer?.cancel();
    try {
      await _pc?.close();
    } catch (_) {}
    _pc = null;
    try {
      _localStream?.getTracks().forEach((t) => t.stop());
      await _localStream?.dispose();
    } catch (_) {}
    _localStream = null;
    _remoteStream = null;
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _closeMedia();
    _localRenderer.dispose();
    _remoteRenderer.dispose();
    super.dispose();
  }

  // --- Aksiyonlar --------------------------------------------------------------

  bool _leaving = false;

  Future<void> _skip() async {
    if (_leaving) return;
    _leaving = true;
    final res = await SocketService.instance.skipMatch();
    // Normalde sunucunun match:ended('skip') olayı requeue akışını tetikler.
    // Ama eşleşme sunucuda yoksa (yeniden başlatma/çevrimdışı) ack ok:false döner;
    // kullanıcı ekranda kilitlenmesin diye yerel olarak yeni aramaya dön.
    if (res['ok'] != true && mounted) {
      _closeMedia();
      Navigator.of(context).pop('requeue');
    }
    _leaving = false;
  }

  Future<void> _endCall() async {
    if (_leaving) return;
    _leaving = true;
    final res = await SocketService.instance.endMatch();
    if (res['ok'] != true && mounted && !_ended) {
      // Sunucu eşleşmeyi bilmiyor: yerel olarak bitiş kartını göster.
      _closeMedia();
      setState(() {
        _ended = true;
        _endReason = 'leave';
        _endedByPeer = false;
        _canAddFriend = false;
        _finalDuration = _seconds;
      });
    }
    _leaving = false;
  }

  /// Mikrofon/kamera açık-kapalı durumunu bir stream'in track'lerine uygular.
  /// Kritik: yeni alınan track'ler varsayılan enabled=true gelir; kullanıcı
  /// arayüzde "kapalı" seçtiyse gerçekte yayın yapmasınlar (gizlilik).
  void _applyTrackToggles(MediaStream stream) {
    for (final t in stream.getAudioTracks()) {
      t.enabled = _micOn;
    }
    for (final t in stream.getVideoTracks()) {
      t.enabled = _camOn;
    }
  }

  /// Kullanıcı izni sonradan verirse: medyayı al, bağlantıya ekle ve yeniden
  /// müzakere et. Teklif üretimi her zaman initiator'da olduğundan non-initiator
  /// yalnızca "renegotiate" sinyali gönderir; glare oluşmaz.
  Future<void> _retryMedia() async {
    if (_retryingMedia || _localStream != null) return;
    setState(() => _retryingMedia = true);
    try {
      final stream = await navigator.mediaDevices.getUserMedia({
        'audio': true,
        'video': {
          'facingMode': 'user',
          'width': {'ideal': 640},
          'height': {'ideal': 480},
        },
      });
      _applyTrackToggles(stream);
      _localStream = stream;
      _localRenderer.srcObject = stream;
      final pc = _pc;
      if (pc != null) {
        for (final t in stream.getTracks()) {
          await pc.addTrack(t, stream);
        }
        if (_isInitiator) {
          await _sendOffer(pc);
        } else {
          // Teklifi initiator üretsin diye ona haber ver.
          SocketService.instance
              .sendSignal(widget.match.matchId, {'renegotiate': true});
        }
      }
      if (mounted) setState(() => _mediaError = false);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('İzin alınamadı. Tarayıcı/uygulama ayarlarından kamera ve mikrofona izin verin.'),
          backgroundColor: Brand.danger,
        ));
      }
    } finally {
      if (mounted) setState(() => _retryingMedia = false);
    }
  }

  Future<void> _toggleMic() async {
    final tracks = _localStream?.getAudioTracks() ?? [];
    setState(() => _micOn = !_micOn);
    for (final t in tracks) {
      t.enabled = _micOn;
    }
  }

  Future<void> _toggleCam() async {
    final tracks = _localStream?.getVideoTracks() ?? [];
    setState(() => _camOn = !_camOn);
    for (final t in tracks) {
      t.enabled = _camOn;
    }
  }

  Future<void> _switchCamera() async {
    final tracks = _localStream?.getVideoTracks() ?? [];
    if (tracks.isEmpty) return;
    try {
      await Helper.switchCamera(tracks.first);
    } catch (_) {}
  }

  Future<void> _addFriend() async {
    final res = await SocketService.instance.addFriend(widget.match.matchId);
    if (!mounted) return;
    if (res['ok'] == true) {
      setState(() => _friendRequested = true);
      if (res['mutual'] != true) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('İstek gönderildi. Karşı taraf da eklerse arkadaş olacaksınız 💜'),
        ));
      }
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text((res['message'] as String?) ?? 'Şu anda eklenemiyor.'),
        backgroundColor: Brand.danger,
      ));
    }
  }

  /// Rapor anında karşı tarafın görüntüsünden kanıt karesi yakalar (plan §2.1).
  Future<String?> _captureSnapshot() async {
    try {
      final track = _remoteStream?.getVideoTracks().firstOrNull;
      if (track == null) return null;
      final buffer = await track.captureFrame();
      return base64Encode(buffer.asUint8List());
    } catch (_) {
      return null;
    }
  }

  Future<void> _openReportSheet() async {
    String? selected;
    final noteCtrl = TextEditingController();
    _reportSheetOpen = true;
    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: EdgeInsets.only(
            left: 20, right: 20, top: 20,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Kullanıcıyı Raporla',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              const Text('Rapor anındaki görüntü kanıt olarak eklenir.',
                  style: TextStyle(color: Brand.textDim, fontSize: 13)),
              const SizedBox(height: 16),
              RadioGroup<String>(
                groupValue: selected,
                onChanged: (v) => setSheet(() => selected = v),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: Catalog.reportCategories.entries
                      .map((e) => RadioListTile<String>(
                            value: e.key,
                            dense: true,
                            activeColor: Brand.secondary,
                            title: Text(e.value,
                                style: const TextStyle(fontSize: 15)),
                          ))
                      .toList(),
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: noteCtrl,
                maxLength: 200,
                decoration: const InputDecoration(
                  hintText: 'Ek açıklama (isteğe bağlı)',
                  counterText: '',
                ),
              ),
              const SizedBox(height: 12),
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: Brand.danger),
                onPressed: selected == null ? null : () => Navigator.of(ctx).pop(true),
                child: const Text('Raporla ve Görüşmeyi Bitir'),
              ),
            ],
          ),
        ),
      ),
    );
    _reportSheetOpen = false;
    if (confirmed != true || selected == null || !mounted) return;

    final snapshot = await _captureSnapshot();
    final res = await SocketService.instance.reportMatch(
      matchId: widget.match.matchId,
      category: selected!,
      note: noteCtrl.text,
      snapshotBase64: snapshot,
    );
    if (!mounted) return;
    if (res['ok'] == true) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Raporunuz alındı. Ekibimiz en kısa sürede inceleyecek. 🙏'),
      ));
      Navigator.of(context).pop(null);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text((res['message'] as String?) ?? 'Rapor gönderilemedi.'),
        backgroundColor: Brand.danger,
      ));
    }
  }

  // --- Arayüz -------------------------------------------------------------------

  String _fmtDuration(int s) =>
      '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !_ended) _endCall();
        if (!didPop && _ended) Navigator.of(context).pop(null);
      },
      child: Scaffold(
        // Video arayüzü koyu; görüşme sonu kartı uygulamanın aydınlık temasında.
        backgroundColor: _ended ? Brand.bg : Colors.black,
        body: _ended ? _endedView() : _callView(),
      ),
    );
  }

  Widget _callView() {
    final peer = widget.match.peer;
    return Stack(
      children: [
        // Uzak görüntü (tam ekran)
        Positioned.fill(
          child: _remoteConnected
              ? RTCVideoView(_remoteRenderer,
                  objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
              : Container(
                  color: Brand.callDark,
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        UserAvatar(
                          name: peer.displayName,
                          avatarUrl: peer.avatarUrl,
                          radius: 40,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          _pcConnected
                              ? '${peer.displayName} bağlandı — kamerası kapalı görünüyor'
                              : 'Bağlanıyor...',
                          style: const TextStyle(color: Brand.textDim),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 12),
                        if (!_pcConnected)
                          const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                      ],
                    ),
                  ),
                ),
        ),
        // Yerel görüntü (küçük pencere)
        Positioned(
          top: MediaQuery.of(context).padding.top + 12,
          right: 12,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: SizedBox(
              width: 100,
              height: 140,
              child: _localStream != null && _camOn
                  ? RTCVideoView(_localRenderer,
                      mirror: true,
                      objectFit:
                          RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                  : Container(
                      color: Brand.callSurface,
                      child: const Icon(Icons.videocam_off_rounded,
                          color: Brand.textDim),
                    ),
            ),
          ),
        ),
        // Üst bilgi çubuğu
        Positioned(
          top: MediaQuery.of(context).padding.top + 12,
          left: 12,
          right: 124,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.55),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(
                          child: Text(
                            '${peer.displayName}, ${peer.age}',
                            style: const TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.w800,
                                fontSize: 16),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(_fmtDuration(_seconds),
                            style: const TextStyle(
                                color: Brand.textDim, fontSize: 13)),
                      ],
                    ),
                    if (widget.match.commonInterests.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          'Ortak: ${widget.match.commonInterests.map((i) => Catalog.interests[i]?.label ?? i).join(', ')}',
                          style: const TextStyle(
                              color: Brand.success, fontSize: 12),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                ),
              ),
              if (_showIcebreaker && widget.match.icebreaker.isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(top: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(colors: [
                      Brand.primary.withValues(alpha: 0.85),
                      Brand.secondary.withValues(alpha: 0.85),
                    ]),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      const Text('💡', style: TextStyle(fontSize: 18)),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(widget.match.icebreaker,
                            style: const TextStyle(
                                color: Colors.white,
                                fontSize: 13,
                                fontWeight: FontWeight.w600)),
                      ),
                      const SizedBox(width: 4),
                      GestureDetector(
                        onTap: () => setState(() => _showIcebreaker = false),
                        child: const Icon(Icons.close_rounded,
                            size: 18, color: Colors.white),
                      ),
                    ],
                  ),
                ),
              if (_mediaError)
                Container(
                  margin: const EdgeInsets.only(top: 8),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Brand.danger.withValues(alpha: 0.85),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Flexible(
                        child: Text(
                          'Kamera/mikrofon izni verilmedi.',
                          style: TextStyle(fontSize: 12, color: Colors.white),
                        ),
                      ),
                      const SizedBox(width: 8),
                      GestureDetector(
                        onTap: _retryingMedia ? null : _retryMedia,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 10, vertical: 5),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            _retryingMedia ? '...' : 'Tekrar dene',
                            style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                                color: Brand.danger),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        // Alt aksiyon çubuğu
        Positioned(
          bottom: MediaQuery.of(context).padding.bottom + 20,
          left: 0,
          right: 0,
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  _roundBtn(
                    icon: _micOn ? Icons.mic_rounded : Icons.mic_off_rounded,
                    color: _micOn ? Brand.callSurface : Brand.danger,
                    onTap: _toggleMic,
                  ),
                  const SizedBox(width: 12),
                  _roundBtn(
                    icon: _camOn
                        ? Icons.videocam_rounded
                        : Icons.videocam_off_rounded,
                    color: _camOn ? Brand.callSurface : Brand.danger,
                    onTap: _toggleCam,
                  ),
                  const SizedBox(width: 12),
                  _roundBtn(
                    icon: Icons.cameraswitch_rounded,
                    color: Brand.callSurface,
                    onTap: _switchCamera,
                  ),
                  const SizedBox(width: 12),
                  _roundBtn(
                    icon: Icons.flag_rounded,
                    color: Brand.warning.withValues(alpha: 0.85),
                    onTap: _openReportSheet,
                    tooltip: 'Raporla',
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Row(
                  children: [
                    Expanded(
                      child: _actionBtn(
                        label: 'Geç',
                        icon: Icons.skip_next_rounded,
                        color: Brand.callSurface,
                        onTap: _skip,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _actionBtn(
                        label: _friendsNow
                            ? 'Arkadaşsınız ✓'
                            : _friendRequested
                                ? 'İstek Gönderildi'
                                : 'Arkadaş Ekle',
                        icon: _friendsNow
                            ? Icons.favorite_rounded
                            : Icons.favorite_border_rounded,
                        color: _friendsNow || _friendRequested
                            ? Brand.secondary.withValues(alpha: 0.6)
                            : Brand.secondary,
                        onTap: _friendsNow || _friendRequested ? null : _addFriend,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _actionBtn(
                        label: 'Bitir',
                        icon: Icons.call_end_rounded,
                        color: Brand.danger,
                        onTap: _endCall,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _roundBtn({
    required IconData icon,
    required Color color,
    required VoidCallback onTap,
    String? tooltip,
  }) {
    final btn = Material(
      color: color,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Icon(icon, size: 24, color: Colors.white),
        ),
      ),
    );
    return tooltip != null ? Tooltip(message: tooltip, child: btn) : btn;
  }

  Widget _actionBtn({
    required String label,
    required IconData icon,
    required Color color,
    VoidCallback? onTap,
  }) {
    return Material(
      color: color,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 22, color: Colors.white),
              const SizedBox(height: 4),
              Text(label,
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: Colors.white)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _endedView() {
    final peer = widget.match.peer;
    final reasonText = switch (_endReason) {
      'leave' => _endedByPeer ? '${peer.displayName} görüşmeden ayrıldı' : 'Görüşmeyi bitirdin',
      'disconnect' => '${peer.displayName} ile bağlantı koptu',
      'report' => 'Görüşme sonlandırıldı',
      _ => 'Görüşme bitti',
    };
    return SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: UserAvatar(
                    name: peer.displayName,
                    avatarUrl: peer.avatarUrl,
                    radius: 44,
                  ),
                ),
                const SizedBox(height: 20),
                Text(reasonText,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                        color: Brand.text,
                        fontSize: 20,
                        fontWeight: FontWeight.w800)),
                const SizedBox(height: 8),
                Text('Süre: ${_fmtDuration(_finalDuration)}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Brand.textDim)),
                const SizedBox(height: 32),
                if (_friendsNow)
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: Brand.success.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Text(
                      '🎉 ${peer.displayName} ile artık arkadaşsınız! Sohbetler sekmesinden yazışabilirsiniz.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Brand.success),
                    ),
                  )
                else if (_canAddFriend)
                  FilledButton.icon(
                    style: FilledButton.styleFrom(
                        backgroundColor:
                            _friendRequested ? Brand.surfaceHigh : Brand.secondary),
                    onPressed: _friendRequested ? null : _addFriend,
                    icon: const Icon(Icons.favorite_rounded),
                    label: Text(_friendRequested
                        ? 'İstek gönderildi — karşı taraf da eklerse arkadaş olacaksınız'
                        : '${peer.displayName} kullanıcısını arkadaş ekle'),
                  ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: () => Navigator.of(context).pop('requeue'),
                  icon: const Icon(Icons.videocam_rounded),
                  label: const Text('Yeni Eşleşme'),
                ),
                const SizedBox(height: 12),
                OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(null),
                  child: const Text('Ana Sayfa'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
