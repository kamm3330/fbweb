' 2D-Grafik: Linien, Kreise, Rechtecke, Text
ScreenRes 640, 480, 32
WindowTitle "Grafik-Demo"
Color RGB(255, 255, 255), RGB(20, 24, 40)
Cls

' Farbverlauf
For y As Integer = 0 To 99
    Line (0, 380 + y)-(639, 380 + y), RGB(30, 60 + y, 120 + y)
Next

' Sonne
Circle (520, 90), 50, RGB(255, 210, 60), , , , F

' Haus
Line (120, 220)-(320, 380), RGB(200, 80, 60), BF
Line (120, 220)-(220, 140), RGB(250, 250, 250)
Line (220, 140)-(320, 220), RGB(250, 250, 250)
Line (190, 300)-(240, 380), RGB(90, 50, 30), BF
Line (140, 250)-(180, 290), RGB(150, 200, 255), BF
Line (260, 250)-(300, 290), RGB(150, 200, 255), BF

' Strahlen
For a As Single = 0 To 6.28 Step 0.4
    Line (520 + Cos(a) * 60, 90 + Sin(a) * 60)-(520 + Cos(a) * 85, 90 + Sin(a) * 85), RGB(255, 230, 120)
Next

Draw String (20, 20), "FreeBASIC im Browser - Taste druecken zum Beenden", RGB(255, 255, 255)
Sleep
