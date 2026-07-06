import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:projex/main.dart';

void main() {
  testWidgets('uygulama açılışta marka ekranını gösterir', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const ProjeXApp());
    expect(find.text('Proje X'), findsOneWidget);
    expect(find.text('Rastgele tanış, gerçek bağ kur'), findsOneWidget);
  });
}
