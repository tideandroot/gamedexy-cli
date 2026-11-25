class_name FlowRoot
extends Control
enum Screen { HOME, SHOP, SETTINGS }
var _screen: Screen = Screen.HOME

func go_to(s: Screen) -> void:
	_screen = s
	match _screen:
		Screen.HOME:
			_show_home()
		Screen.SHOP:
			_show_shop()
		Screen.SETTINGS:
			_show_settings()

func _show_home() -> void:
	var b := Button.new()
	b.pressed.connect(func(): go_to(Screen.SHOP))
	add_child(b)

func _show_shop() -> void:
	var back := Button.new()
	back.pressed.connect(func(): _screen = Screen.HOME)
	add_child(back)

func _show_settings() -> void:
	pass
