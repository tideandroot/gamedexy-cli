import Foundation
struct World { let id: Int; let name: String; let starsToUnlock: Int }
// World(id: 9, name: "Commented out", starsToUnlock: 0) is not a level
enum Worlds {
    static let all: [World] = [
        World(id: 0, name: "Pebble Beach", starsToUnlock: 0),
        World(id: 1, name: "Moss Cave", starsToUnlock: 12),
        World(id: 2, name: "Sky Garden", starsToUnlock: 30),
    ]
    static let featured = World(id: 1, name: "Moss Cave", starsToUnlock: 12)
}
