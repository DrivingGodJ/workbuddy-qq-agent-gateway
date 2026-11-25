import Foundation
import MapKit

enum SpeakerWeatherLocation {
    enum InputError: LocalizedError {
        case invalidFormat
        case cityNotFound
        case ambiguousCity
        case mapUnavailable

        var errorDescription: String? {
            switch self {
            case .invalidFormat: "请输入城市名，或按「城市名,纬度,经度」填写有效坐标。"
            case .cityNotFound: "地图没有找到这个城市。请检查城市名，或填写「城市名,纬度,经度」。"
            case .ambiguousCity: "地图找到了多个同名城市。请补充省份，或填写「城市名,纬度,经度」。"
            case .mapUnavailable: "地图暂时无法查找城市。请稍后重试，或填写「城市名,纬度,经度」。"
            }
        }
    }

    private static func parts(_ value: String) -> [String] {
        value.replacingOccurrences(of: "，", with: ",").components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private static func coordinate(_ parts: [String]) -> CLLocationCoordinate2D? {
        guard parts.count == 3, !parts[0].isEmpty, parts[0].count <= 40,
              let latitude = Double(parts[1]), let longitude = Double(parts[2]) else { return nil }
        let point = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        return CLLocationCoordinate2DIsValid(point) ? point : nil
    }

    static func cityName(in value: String) -> String {
        let fields = parts(value)
        return coordinate(fields) != nil ? fields[0] : value
    }

    @MainActor
    static func resolve(_ value: String, keeping storedValue: String) async throws -> String {
        let city = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !city.isEmpty else { return "" }
        guard city.rangeOfCharacter(from: .controlCharacters) == nil else { throw InputError.invalidFormat }

        let fields = parts(city)
        if coordinate(fields) != nil { return fields.joined(separator: ",") }
        guard fields.count == 1, city.count <= 40 else { throw InputError.invalidFormat }

        let storedFields = parts(storedValue)
        if coordinate(storedFields) != nil, storedFields[0] == city { return storedValue }

        let search = MKLocalSearch.Request()
        search.naturalLanguageQuery = city
        search.resultTypes = .address
        let results: [MKMapItem]
        do {
            results = try await MKLocalSearch(request: search).start().mapItems
        } catch let error as MKError where error.code == .placemarkNotFound {
            throw InputError.cityNotFound
        } catch {
            throw InputError.mapUnavailable
        }

        let name = cityKey(city)
        let matches = results.filter { item in
            guard let displayName = item.name else { return false }
            let key = cityKey(displayName)
            return !key.isEmpty && (key == name || name.hasSuffix("省" + key) || name.hasSuffix("市" + key))
        }
        guard let match = matches.first else { throw InputError.cityNotFound }
        guard matches.count == 1 else { throw InputError.ambiguousCity }
        let point: CLLocationCoordinate2D
        if #available(macOS 26.0, *) {
            point = match.location.coordinate
        } else {
            point = match.placemark.coordinate
        }
        guard CLLocationCoordinate2DIsValid(point) else { throw InputError.cityNotFound }
        return "\(city),\(point.latitude),\(point.longitude)"
    }

    private static func cityKey(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .replacingOccurrences(of: "[市县区]$", with: "", options: .regularExpression)
    }
}
