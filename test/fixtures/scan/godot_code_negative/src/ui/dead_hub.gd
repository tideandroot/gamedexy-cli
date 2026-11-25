class_name DeadHub
extends Control
# Nothing creates this hub, so none of its children can be sure.
var _active_tab := ""

func open_tab(tab_id: String) -> void:
	_active_tab = tab_id
	match _active_tab:
		"play": _build_play()
		"shop": _build_shop()

func show_celebration(title: String) -> void:
	_build_celebration_overlay()

func _build_play() -> void:
	pass

func _build_shop() -> void:
	pass

func _build_celebration_overlay() -> void:
	pass
