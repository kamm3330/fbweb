' Klassischer QBasic-Modus SCREEN 13 (320x200, 256 Farben)
Screen 13
WindowTitle "Plasma (Taste = Ende)"
Dim As Integer t
Do
    ScreenLock
    For y As Integer = 0 To 199
        For x As Integer = 0 To 319
            PSet (x, y), (Int(128 + 127 * Sin(x / 16 + t / 10)) + Int(128 + 127 * Sin(y / 8 + t / 15))) \ 2
        Next
    Next
    ScreenUnlock
    t += 1
    Sleep 20, 1
Loop While InKey = ""
