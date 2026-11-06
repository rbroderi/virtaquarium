' Copyright (c) 2026 Roku, Inc.
' SPDX-License-Identifier: MIT

' Launched from the home screen (for testing).
sub Main()
    ShowAquarium()
end sub

' Launched by the OS as the screensaver (Settings > Theme > Screensavers).
sub RunScreenSaver()
    ShowAquarium()
end sub

sub ShowAquarium()
    screen = CreateObject("roSGScreen")
    m.port = CreateObject("roMessagePort")
    screen.setMessagePort(m.port)

    scene = screen.CreateScene("BaseAppScene")
    screen.show()

    while(true)
        msg = wait(0, m.port)
        msgType = type(msg)
        if msgType = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        else
            print "Unhandled message type: "; msgType
        end if
    end while
end sub
