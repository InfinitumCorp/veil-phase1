import SwiftUI

/// Colors and type from `veil-chrome/src/shared/veil.css` and
/// `veil-prototype/static/shell.css`. Hex values are locked by a unit test.
enum VeilColor {
    static let bg = Color(veilHex: 0xFFFFFF)
    static let ink = Color(veilHex: 0x111820)
    static let inkQuiet = Color(veilHex: 0x6B6B74)
    static let quiet = Color(veilHex: 0x5F6670)
    static let rule = Color(veilHex: 0xE8E8EC)
    static let shellRule = Color(veilHex: 0xE3E4E8)
    static let hover = Color(veilHex: 0xF3F3F5)
    static let strip = Color(veilHex: 0xEEF0F3)
    static let shellHover = Color(veilHex: 0xE2E5E9)
    static let focus = Color(veilHex: 0x1F5FD6)
    static let accent = Color(veilHex: 0x5B3FD1)
    static let appLink = Color(veilHex: 0x49545E)
    static let connected = Color(veilHex: 0x1F9D55)
    static let connecting = Color(veilHex: 0xD29A00)
    static let error = Color(veilHex: 0xD1342F)
    static let dotIdle = Color(veilHex: 0xB5B5BD)
    static let disabled = Color(veilHex: 0xB4B8BF)
    static let contrastRule = Color(veilHex: 0x9A9AA3)
    static let shadow = Color(red: 17 / 255, green: 24 / 255, blue: 32 / 255)

    static func status(_ state: TorConnectionState, blocked: Bool) -> Color {
        if blocked { return error }
        switch state {
        case .connected: return connected
        case .connecting: return connecting
        case .error, .blocked: return error
        case .unknown: return dotIdle
        }
    }
}

extension Color {
    init(veilHex hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

enum VeilFont {
    static func text(_ size: CGFloat) -> Font {
        .custom("Helvetica Neue", size: size)
    }
}

struct VeilPalette {
    var inkQuiet: Color
    var rule: Color

    init(contrast: ColorSchemeContrast) {
        if contrast == .increased {
            inkQuiet = VeilColor.ink
            rule = VeilColor.contrastRule
        } else {
            inkQuiet = VeilColor.inkQuiet
            rule = VeilColor.rule
        }
    }
}

/// Toolbar icons drawn from the same 24×24 strokes as `veil-prototype/static/index.html`.
struct VeilIcon: View {
    enum Kind {
        case back, forward, reload, identity, menu, close, external
    }

    var kind: Kind
    var size: CGFloat = 18

    var body: some View {
        shape
            .stroke(style: StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private var shape: AnyShape {
        switch kind {
        case .back:
            AnyShape(StrokePath { path in
                path.move(to: CGPoint(x: 19, y: 12))
                path.addLine(to: CGPoint(x: 5, y: 12))
                path.move(to: CGPoint(x: 11, y: 6))
                path.addLine(to: CGPoint(x: 5, y: 12))
                path.addLine(to: CGPoint(x: 11, y: 18))
            })
        case .forward:
            AnyShape(StrokePath { path in
                path.move(to: CGPoint(x: 5, y: 12))
                path.addLine(to: CGPoint(x: 19, y: 12))
                path.move(to: CGPoint(x: 13, y: 6))
                path.addLine(to: CGPoint(x: 19, y: 12))
                path.addLine(to: CGPoint(x: 13, y: 18))
            })
        case .reload:
            AnyShape(StrokePath { path in
                path.addArc(
                    center: CGPoint(x: 12, y: 12.5),
                    radius: 6.4,
                    startAngle: .degrees(300),
                    endAngle: .degrees(40),
                    clockwise: true
                )
                path.move(to: CGPoint(x: 20, y: 4))
                path.addLine(to: CGPoint(x: 20, y: 11))
                path.addLine(to: CGPoint(x: 13, y: 11))
            })
        case .identity:
            AnyShape(StrokePath { path in
                path.move(to: CGPoint(x: 14.5, y: 3.5))
                path.addLine(to: CGPoint(x: 8.5, y: 12.5))
                path.move(to: CGPoint(x: 6, y: 13))
                path.addLine(to: CGPoint(x: 13, y: 17))
                path.addLine(to: CGPoint(x: 10.5, y: 21.5))
                path.addQuadCurve(to: CGPoint(x: 3, y: 16.5), control: CGPoint(x: 4, y: 20))
                path.move(to: CGPoint(x: 8.5, y: 12.5))
                path.addLine(to: CGPoint(x: 14, y: 15.5))
            })
        case .menu:
            AnyShape(StrokePath { path in
                for y in [CGFloat(5), 12, 19] {
                    path.move(to: CGPoint(x: 12, y: y))
                    path.addEllipse(in: CGRect(x: 10.6, y: y - 1.4, width: 2.8, height: 2.8))
                }
            })
        case .close:
            AnyShape(StrokePath { path in
                path.move(to: CGPoint(x: 6, y: 6))
                path.addLine(to: CGPoint(x: 18, y: 18))
                path.move(to: CGPoint(x: 18, y: 6))
                path.addLine(to: CGPoint(x: 6, y: 18))
            })
        case .external:
            AnyShape(StrokePath { path in
                path.move(to: CGPoint(x: 14, y: 4))
                path.addLine(to: CGPoint(x: 20, y: 4))
                path.addLine(to: CGPoint(x: 20, y: 10))
                path.move(to: CGPoint(x: 20, y: 4))
                path.addLine(to: CGPoint(x: 11, y: 13))
                path.move(to: CGPoint(x: 18, y: 14))
                path.addLine(to: CGPoint(x: 18, y: 19))
                path.addLine(to: CGPoint(x: 5, y: 19))
                path.addLine(to: CGPoint(x: 5, y: 6))
                path.addLine(to: CGPoint(x: 10, y: 6))
            })
        }
    }
}

private struct StrokePath: Shape {
    var draw: (inout Path) -> Void
    func path(in rect: CGRect) -> Path {
        var path = Path()
        draw(&path)
        let scale = min(rect.width, rect.height) / 24
        return path.applying(CGAffineTransform(scaleX: scale, y: scale))
    }
}

/// Type-erased shape so the icon switch can return different paths.
struct AnyShape: Shape {
    private let builder: (CGRect) -> Path
    init<S: Shape>(_ shape: S) {
        builder = { rect in shape.path(in: rect) }
    }
    func path(in rect: CGRect) -> Path { builder(rect) }
}
