import AppKit
import SwiftUI

/// Offline brand treatment shared by plans, decisions, Gmail matches and spending.
struct ServiceMark: View {
    let name: String
    var size: CGFloat = 36

    private static let images = NSCache<NSString, NSImage>()

    private var image: NSImage? {
        guard let url = ServiceLogoCatalog.imageURL(for: name) else { return nil }
        let key = url.lastPathComponent as NSString
        if let cached = Self.images.object(forKey: key) { return cached }
        guard let value = NSImage(contentsOf: url) else { return nil }
        Self.images.countLimit = 160
        Self.images.setObject(value, forKey: key)
        return value
    }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit().padding(size * 0.13)
                    .frame(width: size, height: size)
                    .background(ServiceLogoCatalog.logo(for: name)?.backdrop == "dark" ? Color(white: 0.12) : Color.white,
                                in: RoundedRectangle(cornerRadius: size * 0.26))
                    .overlay(RoundedRectangle(cornerRadius: size * 0.26).strokeBorder(Color.black.opacity(0.08)))
            } else {
                Text(ServiceLogoCatalog.initial(for: name))
                    .font(.system(size: size * 0.47, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.tint).frame(width: size, height: size)
                    .background(Palette.pale, in: RoundedRectangle(cornerRadius: size * 0.26))
            }
        }.accessibilityHidden(true)
    }
}
