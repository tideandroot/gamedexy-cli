class_name ShopSheets
extends Control
# One bottom sheet, rebuilt for each tab.
var _active_sheet := ""

func open_sheet(sheet_id: String) -> void:
	_active_sheet = sheet_id
	_rebuild()

func show_celebration(title: String, body: String) -> void:
	_build_celebration_overlay()

func _rebuild() -> void:
	match _active_sheet:
		"upgrades": _build_upgrades()
		"shop": _build_shop()
		"map":
			_build_world_map()
		_:
			pass

func _build_upgrades() -> void:
	var b := Button.new()
	b.pressed.connect(func(): open_sheet("shop"))
	add_child(b)

func _build_shop() -> void:
	pass

func _build_world_map() -> void:
	pass

func _build_celebration_overlay() -> void:
	pass
